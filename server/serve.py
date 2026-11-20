#!/usr/bin/env python3
"""Servidor de desarrollo de Elffuss Code: sirve web/, hace de proxy en /proxy?url=…
y recoge /proxy/feedback.

En producción, /proxy de code.elffuss.com lo atiende el backend compartido
(server/serve.py de elffuss-claw); este fichero es el de desarrollo, con el
mismo proxy y el mismo /proxy/feedback.

Uso:  python3 server/serve.py [puerto]   (por defecto 8642)
      Escucha solo en 127.0.0.1; ELFFUSS_BIND=0.0.0.0 lo abre a la red.
"""
import datetime
import functools
import http.client
import http.server
import ipaddress
import json
import re
import socket
import socketserver
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
import zlib
from collections import namedtuple
from http import HTTPStatus
from pathlib import Path

import os

ROOT = os.environ.get('ELFFUSSCODE_ROOT') or str(Path(__file__).resolve().parent.parent / 'web')
MAX_PROXY_BYTES = 2_000_000
# En desarrollo, /v1 (modelo) se reenvía a producción; en producción lo
# resuelve nginx directamente contra llama-server, no este forward.
LM_UPSTREAM = os.environ.get('ELFFUSS_LM') or 'https://elffuss.com'


# ---------------------------------------------------------------- /proxy?url=…
# El agente lee por aquí las webs que no mandan CORS. La petición la hace EL
# SERVIDOR, así que sin cerrojos esto es un SSRF de manual: cualquiera podría
# pedirle 127.0.0.1:<otro servicio de la máquina> o la metadata de la nube
# (169.254.169.254). Reglas:
#  · solo http/https a los puertos 80 y 443, sin usuario:contraseña en la url;
#  · el nombre se resuelve UNA vez, se rechaza si CUALQUIERA de sus direcciones
#    no es pública, y se conecta a ESA dirección (Host y SNI siguen siendo el
#    nombre): un DNS que cambie de respuesta entre la comprobación y la
#    conexión (DNS rebinding) no cuela nada;
#  · IPv4 solo en forma canónica a.b.c.d: 2130706433, 0x7f.1 o 0177.0.0.1 son
#    127.0.0.1 para el resolver, y se rechazan antes de llegar a él;
#  · las redirecciones se siguen a mano y cada salto se valida igual;
#  · no viaja ninguna cabecera del cliente (ni cookies ni Authorization) y el
#    User-Agent es fijo;
#  · tope de bytes con aviso (X-Proxy-Truncated: 1, nunca un 200 mudo), plazo
#    total, y límites por IP y de peticiones simultáneas.
# El mismo código vive en server/serve.py de elffuss-claw (el backend de
# producción, que también atiende /proxy de code.elffuss.com): cambiar los dos.
PROXY_USER_AGENT = 'Mozilla/5.0 (Elffuss Code)'
PROXY_PORTS = (80, 443)
PROXY_MAX_URL = 4096
PROXY_MAX_REDIRECTS = 5
PROXY_CONNECT_TIMEOUT_S = 8
PROXY_READ_TIMEOUT_S = 15
PROXY_TOTAL_TIMEOUT_S = 30   # el proxy_read_timeout de nginx tiene que quedar por encima
PROXY_RATE_WINDOW_S, PROXY_RATE_MAX = 60, 30
PROXY_SLOTS = threading.BoundedSemaphore(8)

# Además de lo no público, lo que se liste aquí (CIDR separados por comas), por
# ejemplo las IP públicas de la propia máquina si algún vhost confía en ellas.
PROXY_DENY = tuple(ipaddress.ip_network(n.strip(), strict=False)
                   for n in (os.environ.get('ELFFUSS_PROXY_DENY') or '').split(',') if n.strip())

_V4_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    '0.0.0.0/8',          # «esta red»: 0.0.0.0 acaba en localhost en Linux
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',   # privadas
    '100.64.0.0/10',      # CGNAT, con la metadata de algunas nubes (100.100.100.200)
    '127.0.0.0/8',        # loopback
    '169.254.0.0/16',     # enlace local, con la metadata de la nube (169.254.169.254)
    '192.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24',   # IETF y documentación
    '192.88.99.0/24',     # relé 6to4
    '198.18.0.0/15',      # bancos de pruebas
    '224.0.0.0/4',        # multicast (Python lo da por «global»)
    '240.0.0.0/4',        # reservada, con 255.255.255.255
))
# Fuera de 2000::/3 queda todo lo que no es unicast global: ::, ::1, las
# IPv4-mapeadas (::ffff:a.b.c.d) y compatibles (::a.b.c.d), NAT64 (64:ff9b::),
# ULA (fc00::/7), enlace local (fe80::/10) y multicast (ff00::/8).
_V6_UNICAST = ipaddress.ip_network('2000::/3')
_V6_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    '2001::/23',          # asignaciones del IETF, con Teredo (2001::/32)
    '2001:db8::/32',      # documentación
    '2002::/16',          # 6to4: lleva una IPv4 dentro
    '3fff::/20',          # documentación (RFC 9637)
))
# Nombres que nunca son internet, se resuelvan a lo que se resuelvan.
_RESERVED_NAMES = ('localhost', 'local', 'internal', 'localdomain', 'home.arpa',
                   'invalid', 'test', 'example', 'onion', 'alt')

_CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')
_NETLOC_RE = re.compile(r'(\[[^\[\]]*\]|[^\[\]:]*)(?::([0-9]*))?')
_LABEL_RE = re.compile(r'[a-z0-9_-]{1,63}')
_NUMERIC_LABEL_RE = re.compile(r'0x[0-9a-f]*|[0-9]+')
_OCTET_RE = re.compile(r'0|[1-9][0-9]{0,2}')
_CONTENT_TYPE_RE = re.compile(r'[\x21-\x7e][\x20-\x7e]{0,199}')
_REDIRECTS = (301, 302, 303, 307, 308)
_UPSTREAM_HEADERS = {   # lo ÚNICO que se manda al destino, además de Host
    'User-Agent': PROXY_USER_AGENT,
    'Accept-Encoding': 'identity',
    'Connection': 'close',
}
_AI_FLAGS = getattr(socket, 'AI_ADDRCONFIG', 0)

Target = namedtuple('Target', 'scheme host port path url addrs')
ProxyResult = namedtuple('ProxyResult', 'status upstream_status content_type body truncated')


class ProxyRefused(Exception):
    """Respuesta de error del proxy: estado HTTP, código corto para la cabecera
    X-Proxy-Error y un motivo legible. Nunca lleva la dirección resuelta."""

    def __init__(self, status, code, detail):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


def _parse_ip(text):
    try:
        return ipaddress.ip_address(str(text).split('%', 1)[0])
    except ValueError:
        return None


def _in_block_lists(ip):
    """Las listas de arriba, solas: no dependen de la versión de Python."""
    if ip.version == 6:
        return ip not in _V6_UNICAST or any(ip in n for n in _V6_BLOCKED)
    return any(ip in n for n in _V4_BLOCKED)


def _ip_is_public(ip):
    """¿Se puede conectar a esta dirección? Las listas propias, y además las
    banderas de ipaddress, que cambian de una versión de Python a otra (para
    ellas 224.0.0.1 es «global»)."""
    if _in_block_lists(ip):
        return False
    if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
            or ip.is_reserved or ip.is_unspecified or not ip.is_global):
        return False
    return not any(ip in n for n in PROXY_DENY)


def _is_loopback(text):
    ip = _parse_ip(text)
    if ip is not None and ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip is not None and ip.is_loopback


def _rate_key(ip_text):
    """Clave del límite por IP: una IPv6 cuenta por su /64, que es lo que
    tiene cualquier cliente para él solo."""
    ip = _parse_ip(ip_text)
    if ip is None:
        return str(ip_text)[:64]
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


def _parse_host(raw):
    """→ (ip, host): ip si el host es una dirección literal (y host su forma
    canónica); si es un nombre, (None, nombre en ASCII y minúsculas)."""
    if raw.startswith('['):
        inner = raw[1:-1]
        if '%' in inner:   # zona (fe80::1%eth0): solo existe en enlace local
            raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (dirección de enlace local)')
        try:
            ip = ipaddress.IPv6Address(inner)
        except ValueError:
            raise ProxyRefused(400, 'bad-host', 'dirección IPv6 mal formada') from None
        return ip, str(ip)
    host = raw[:-1] if raw.endswith('.') else raw
    try:
        host = host.encode('idna').decode('ascii').lower()
    except UnicodeError:
        raise ProxyRefused(400, 'bad-host', 'nombre de host no válido') from None
    labels = host.split('.')
    if not all(_LABEL_RE.fullmatch(label) for label in labels):
        raise ProxyRefused(400, 'bad-host', 'nombre de host no válido')
    # Si la última etiqueta es un número, el resolver lo toma por una IPv4
    # (inet_aton acepta decimal, octal, hex y formas cortas): solo se admite
    # la forma a.b.c.d, en decimal y sin ceros a la izquierda.
    if _NUMERIC_LABEL_RE.fullmatch(labels[-1]):
        if len(labels) != 4 or not all(_OCTET_RE.fullmatch(x) and int(x) <= 255 for x in labels):
            raise ProxyRefused(400, 'odd-ip', 'las IPv4 van en forma a.b.c.d, en decimal')
        return ipaddress.IPv4Address(host), host
    if len(labels) < 2 or any(host == s or host.endswith('.' + s) for s in _RESERVED_NAMES):
        raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (nombre local o reservado)')
    return None, host


def _getaddrinfo(*args):   # los tests sustituyen esto: es el único punto de DNS
    return socket.getaddrinfo(*args)


def _resolve(host, port):
    """Resuelve UNA vez. Si alguna dirección no es pública se rechaza todo:
    elegir la buena dejaría a un DNS hostil decidir a cuál se conecta."""
    try:
        infos = _getaddrinfo(host, port, 0, socket.SOCK_STREAM, socket.IPPROTO_TCP, _AI_FLAGS)
    except (OSError, UnicodeError):
        raise ProxyRefused(502, 'dns', 'no se pudo resolver el host') from None
    addrs = []
    for family, _type, _proto, _canon, sockaddr in infos:
        ip = _parse_ip(sockaddr[0]) if family in (socket.AF_INET, socket.AF_INET6) else None
        if ip is None or not _ip_is_public(ip):
            raise ProxyRefused(403, 'forbidden-destination',
                               'destino no permitido (el nombre resuelve a una dirección no pública)')
        if (family, sockaddr) not in addrs:
            addrs.append((family, sockaddr))
    if not addrs:
        raise ProxyRefused(502, 'dns', 'el host no tiene direcciones')
    return addrs


def _check_url(url):
    """Valida una url y la resuelve: → Target con las direcciones ya
    comprobadas, que son las únicas a las que se conectará."""
    if not url:
        raise ProxyRefused(400, 'bad-url', 'falta el parámetro url')
    if len(url) > PROXY_MAX_URL or _CTRL_RE.search(url):
        raise ProxyRefused(400, 'bad-url', 'url demasiado larga o con caracteres de control')
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        raise ProxyRefused(400, 'bad-url', 'url mal formada') from None
    scheme = parts.scheme.lower()
    if scheme not in ('http', 'https'):
        raise ProxyRefused(400, 'bad-scheme', 'solo http:// y https://')
    if '@' in parts.netloc:
        raise ProxyRefused(400, 'userinfo', 'la url no puede llevar usuario ni contraseña')
    m = _NETLOC_RE.fullmatch(parts.netloc)
    if not m or not m.group(1):
        raise ProxyRefused(400, 'bad-host', 'url sin host válido')
    default_port = 443 if scheme == 'https' else 80
    port = int(m.group(2)) if m.group(2) else default_port
    if port not in PROXY_PORTS:
        raise ProxyRefused(403, 'forbidden-port', 'solo se permiten los puertos 80 y 443')
    ip, host = _parse_host(m.group(1))
    if ip is None:
        addrs = _resolve(host, port)
    elif not _ip_is_public(ip):
        raise ProxyRefused(403, 'forbidden-destination', 'destino no permitido (dirección no pública)')
    elif ip.version == 6:
        addrs = [(socket.AF_INET6, (host, port, 0, 0))]
    else:
        addrs = [(socket.AF_INET, (host, port))]
    try:
        path = urllib.parse.quote(parts.path or '/', safe="/%:@!$&'()*+,;=~")
        if parts.query:
            path += '?' + urllib.parse.quote(parts.query, safe="/?%:@!$&'()*+,;=~")
    except UnicodeError:
        raise ProxyRefused(400, 'bad-url', 'url mal formada') from None
    netloc = ('[%s]' % host if ':' in host else host) + ('' if port == default_port else ':%d' % port)
    return Target(scheme, host, port, path, '%s://%s%s' % (scheme, netloc, path), tuple(addrs))


def _shutdown(sock):
    try:   # socket.socket.shutdown también sobre un SSLSocket: corta el fd sin tocar el estado TLS
        socket.socket.shutdown(sock, socket.SHUT_RDWR)
    except (OSError, TypeError, ValueError):
        pass


class _Deadline:
    """Plazo TOTAL de una petición al proxy, redirecciones incluidas. Los
    timeouts de socket cuentan por operación, y un servidor que gotea un byte
    cada pocos segundos los esquiva todos: al vencer el plazo se corta el
    socket en uso y la lectura bloqueada falla."""

    def __init__(self, seconds):
        self._end = time.monotonic() + seconds
        self._lock = threading.Lock()
        self._sock = None
        self._fired = False
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def remaining(self):
        return self._end - time.monotonic()

    def expired(self):
        return self._fired or self.remaining() <= 0

    def watch(self, sock):
        with self._lock:
            self._sock = sock
            fired = self._fired
        if fired:
            _shutdown(sock)

    def _fire(self):
        with self._lock:
            self._fired = True
            sock = self._sock
        if sock is not None:
            _shutdown(sock)

    def cancel(self):
        self._timer.cancel()
        with self._lock:
            self._sock = None


def _dial(family, sockaddr, timeout):
    """Conexión TCP a una dirección YA validada (los tests sustituyen esto)."""
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(sockaddr)
    except BaseException:
        sock.close()
        raise
    return sock


def _connect(target, deadline):
    last = None
    for family, sockaddr in target.addrs[:3]:
        remaining = deadline.remaining()
        if remaining <= 0:
            break
        try:
            sock = _dial(family, sockaddr, min(PROXY_CONNECT_TIMEOUT_S, remaining))
        except OSError as e:
            last = e
            continue
        sock.settimeout(PROXY_READ_TIMEOUT_S)
        deadline.watch(sock)
        return sock
    if deadline.expired():
        raise socket.timeout('plazo agotado')
    raise last or OSError('sin conexión')


@functools.lru_cache(maxsize=None)
def _tls_context():
    ctx = ssl.create_default_context()   # verifica certificado y nombre
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP contra la dirección ya validada; Host sigue siendo el nombre."""

    def __init__(self, target, deadline):
        super().__init__(target.host, target.port, timeout=PROXY_READ_TIMEOUT_S)
        self._target, self._deadline = target, deadline

    def connect(self):
        self.sock = _connect(self._target, self._deadline)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS contra la dirección ya validada; el SNI y la verificación del
    certificado van contra el nombre, no contra la IP."""

    def __init__(self, target, deadline):
        self._tls = _tls_context()
        super().__init__(target.host, target.port, timeout=PROXY_READ_TIMEOUT_S, context=self._tls)
        self._target, self._deadline = target, deadline

    def connect(self):
        raw = _connect(self._target, self._deadline)
        try:
            tls = self._tls.wrap_socket(raw, server_hostname=self._target.host,
                                        do_handshake_on_connect=False)
        except BaseException:
            raw.close()
            raise
        try:
            tls.settimeout(PROXY_READ_TIMEOUT_S)
            self._deadline.watch(tls)   # el socket de antes ya no es dueño del fd
            tls.do_handshake()
        except BaseException:
            tls.close()
            raise
        self.sock = tls


def _header_text(value):
    """http.client entrega las cabeceras como latin-1; una Location con UTF-8
    crudo se recupera aquí antes de volver a codificarla."""
    try:
        return value.encode('latin-1').decode('utf-8')
    except UnicodeError:
        return value


def _inflate(data, encoding, limit):
    for wbits in ((16 + zlib.MAX_WBITS,) if encoding != 'deflate' else (zlib.MAX_WBITS, -zlib.MAX_WBITS)):
        try:
            out = zlib.decompressobj(wbits).decompress(data, limit + 1)   # nunca más de limit+1
        except zlib.error:
            continue
        return out[:limit], len(out) > limit
    raise ProxyRefused(502, 'encoding', 'la web mandó un cuerpo comprimido corrupto')


def _read_body(resp):
    limit = MAX_PROXY_BYTES
    chunks, total = [], 0
    while total <= limit:
        chunk = resp.read(min(1 << 16, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    raw, truncated = b''.join(chunks), total > limit
    # Se pide identity; si aun así llega comprimido, se descomprime con tope
    # (una bomba gzip no pasa de limit+1 bytes) y el cliente lo recibe plano.
    encoding = (resp.getheader('Content-Encoding') or '').strip().lower()
    if encoding in ('', 'identity'):
        return raw[:limit], truncated
    if encoding not in ('gzip', 'x-gzip', 'deflate'):
        raise ProxyRefused(502, 'encoding', 'la web respondió comprimida en un formato no soportado')
    body, more = _inflate(raw, encoding, limit)
    return body, truncated or more


def _fetch(url, deadline):
    for hop in range(PROXY_MAX_REDIRECTS + 1):
        try:
            target = _check_url(url)
        except ProxyRefused as e:
            if hop == 0 or e.code == 'dns':
                raise
            if e.status == 403:
                raise ProxyRefused(403, 'forbidden-redirect', 'la web redirige a un destino no permitido') from None
            raise ProxyRefused(502, 'bad-redirect', 'la web redirige a una url no válida') from None
        conn_class = _PinnedHTTPSConnection if target.scheme == 'https' else _PinnedHTTPConnection
        conn = conn_class(target, deadline)
        try:
            conn.request('GET', target.path, headers=_UPSTREAM_HEADERS)
            resp = conn.getresponse()
            if resp.status in _REDIRECTS:
                location = resp.getheader('Location')
                if not location or not location.strip():
                    raise ProxyRefused(502, 'bad-redirect', 'redirección sin destino')
                url = urllib.parse.urljoin(target.url, _header_text(location).strip())
                continue
            content_type = (resp.getheader('Content-Type') or '').strip()
            if not _CONTENT_TYPE_RE.fullmatch(content_type):
                content_type = 'application/octet-stream'
            body, truncated = _read_body(resp)
            # Cortar el socket al vencer el plazo se lee como un fin de
            # fichero, y para http.client eso puede ser un final normal (unas
            # cabeceras a medias, un cuerpo sin longitud): lo leído después
            # del corte no es la respuesta, es un 504.
            if deadline.expired():
                raise socket.timeout('plazo agotado')
            # El estado real del destino (un 404 es un 404, no un 200 ni un
            # 502); lo que no es un final normal (1xx, 3xx sueltos) es un 502.
            status = resp.status if 200 <= resp.status < 300 or 400 <= resp.status < 600 else 502
            return ProxyResult(status, resp.status, content_type, body, truncated)
        finally:
            conn.close()
    raise ProxyRefused(502, 'too-many-redirects', 'demasiadas redirecciones')


def proxy_fetch(url):
    """GET a una url pública con todas las reglas de arriba → ProxyResult, o
    ProxyRefused con el estado y el motivo."""
    deadline = _Deadline(PROXY_TOTAL_TIMEOUT_S)
    try:
        return _fetch(url, deadline)
    except ProxyRefused:
        raise
    except Exception as e:  # noqa: BLE001 — cualquier fallo del destino es un 502/504 con motivo
        if deadline.expired() or isinstance(e, socket.timeout):
            raise ProxyRefused(504, 'timeout', 'la web no respondió a tiempo') from None
        if isinstance(e, ssl.SSLError):
            raise ProxyRefused(502, 'tls', 'fallo TLS con la web (%s)' % type(e).__name__) from None
        raise ProxyRefused(502, 'upstream', 'no se pudo leer la web (%s)' % type(e).__name__) from None
    finally:
        deadline.cancel()


class _RateLimiter:
    """Ventana deslizante por clave, segura entre hilos, que olvida las claves
    viejas (la de /proxy/report crece sin fin)."""

    def __init__(self, window_s, max_hits):
        self.window_s, self.max_hits = window_s, max_hits
        self._hits = {}
        self._lock = threading.Lock()
        self._swept = time.monotonic()

    def allow(self, key):
        now = time.monotonic()
        with self._lock:
            if now - self._swept > self.window_s:
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.window_s}
                self._swept = now
            hits = [t for t in self._hits.get(key, ()) if now - t < self.window_s]
            ok = len(hits) < self.max_hits
            if ok:
                hits.append(now)
            self._hits[key] = hits
            return ok


PROXY_RATE = _RateLimiter(PROXY_RATE_WINDOW_S, PROXY_RATE_MAX)


# ---- /proxy/feedback: the same block in elffuss-claw and elffuss-code ----
# Valoraciones (buena o mala respuesta) y avisos de una conversación del chat de
# elffuss.com (site-chat/chat/feedback.js). El navegador anonimiza la
# conversación ANTES de mandarla, enseña exactamente lo que va a salir y deja
# unos segundos para cancelar. Aquí se comprueba que lo que llega tiene la forma
# exacta del esquema v1 y que no trae nada con pinta de dato personal, y se
# guarda TAL CUAL: sin IP, sin User-Agent, sin hora y sin nada más que diga
# quién lo mandó (el día va en el nombre del fichero). /proxy/report sí guarda
# la IP: de él no se aprovecha ni el registro ni el límite.
#  · quién llama, lo primero (_proxy_caller_ok): así otra web no gasta desde el
#    navegador de alguien el cupo de esa persona;
#  · límites solo en memoria, por cliente (_feedback_rate_key: una IPv6 cuenta
#    por su /56) y entre todos; no se escriben ni salen en el log. El cupo de
#    todos solo lo gasta un envío que pasa el esquema y la red de seguridad: la
#    basura de unos pocos no cierra la puerta a los demás;
#  · ni una línea en el log por envío, tampoco la de la petición
#    (_feedback_unlogged): con su hora, y las líneas del fichero en orden de
#    llegada, se sabría qué línea mandó quién;
#  · Content-Length obligatorio, tope de 256 KiB y un plazo total para leer;
#  · un .jsonl por día UTC, en ASCII puro (_feedback_line), 0600 en una carpeta
#    0700, con tope por día y en total, y 90 días de vida (los poda un hilo
#    aunque nadie mande nada). Manda el tope del día: llenarlo cuesta como
#    mucho lo que queda de ese día;
#  · la respuesta es {"ok":true} o {"ok":false,"error":"<código>"}: nunca
#    repite nada de lo recibido ni el texto de una excepción.
class _FeedbackLimiter(_RateLimiter):
    """El _RateLimiter de /proxy con dos cosas más. full() mira sin gastar: así
    se rechaza antes de leer el cuerpo sin que lo que luego no vale gaste el
    cupo de todos. max_keys pone tope a las claves que se recuerdan: con la
    tabla llena de claves vivas, una nueva no entra (take da 'crowded') en vez
    de crecer con cada dirección que alguien estrene."""

    def __init__(self, window_s, max_hits, max_keys=None):
        super().__init__(window_s, max_hits)
        self.max_keys = max_keys

    def _live(self, key, now):
        return [t for t in self._hits.get(key, ()) if now - t < self.window_s]

    def full(self, key):
        """True si a key no le queda cupo. No gasta nada."""
        with self._lock:
            return len(self._live(key, time.monotonic())) >= self.max_hits

    def take(self, key):
        """Gasta una de key → 'ok', 'limited' (sin cupo) o 'crowded' (key es
        nueva y ya hay max_keys claves con algo dentro de la ventana)."""
        now = time.monotonic()
        with self._lock:
            crowded = self.max_keys is not None and key not in self._hits and len(self._hits) >= self.max_keys
            # La barrida de siempre, una por ventana; con la tabla llena, además,
            # una por segundo como mucho, para soltar las claves que ya caducaron.
            if now - self._swept > self.window_s or (crowded and now - self._swept >= 1):
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.window_s}
                self._swept = now
                crowded = crowded and len(self._hits) >= self.max_keys
            if crowded:
                return 'crowded'
            hits = self._live(key, now)
            ok = len(hits) < self.max_hits
            if ok:
                hits.append(now)
            self._hits[key] = hits
            return 'ok' if ok else 'limited'


FEEDBACK_PATH = os.environ.get('ELFFUSS_FEEDBACK') or str(
    Path(os.environ.get('ELFFUSS_REPORTS') or (Path.home() / 'elffuss' / 'reports.jsonl')).parent / 'feedback.jsonl')
FEEDBACK_MAX_BYTES = 262_144          # = CAPS.bodyBytes de feedback-payload.js = client_max_body_size de nginx
FEEDBACK_MAX_MESSAGES = 400
FEEDBACK_MAX_TEXT = 65_536            # puntos de código por texto
FEEDBACK_READ_TIMEOUT_S = 10          # para el cuerpo ENTERO, no por lectura
FEEDBACK_RATE = _FeedbackLimiter(600, 10, max_keys=10_000)              # por cliente: 10 cada 10 minutos
FEEDBACK_GLOBAL_RATE = _FeedbackLimiter(3600, int(os.environ.get('ELFFUSS_FEEDBACK_GLOBAL_MAX') or 200))   # entre todos, por hora
FEEDBACK_RETRY_AFTER_S = 600
FEEDBACK_TOTAL_MAX_BYTES = 200 * 1024 * 1024
FEEDBACK_KEEP_DAYS = max(0, int(os.environ.get('ELFFUSS_FEEDBACK_DAYS') or 90))
# El tope del día es el que manda: los días que se guardan más el de hoy caben
# enteros en el total. Quien llene un día (abusando, por ejemplo) cierra lo que
# queda de ese día UTC y nada más; si mandase el total, la puerta seguiría
# cerrada hasta que la poda borrase algo, meses después.
FEEDBACK_DAY_MAX_BYTES = min(2 * 1024 * 1024, FEEDBACK_TOTAL_MAX_BYTES // (FEEDBACK_KEEP_DAYS + 1))
FEEDBACK_TIDY_EVERY_S = 6 * 3600
# La red de seguridad de después del anonimizador, la misma que LEFTOVER de
# anonymize.js: correos, enlaces que no son elffuss.com sin ruta, www.algo y
# carpetas personales (ci); 5 cifras seguidas o más, claves con prefijo
# conocido, JWT y claves privadas (cs). Las etiquetas [TIPO_n] se tapan antes
# con espacios del mismo largo. re.A en las dos: sin él, [a-z] con re.I casaría
# también la s larga y el signo Kelvin, y en JS (sin la bandera u) no casan.
# Se cambian a la vez aquí, en la otra copia de este bloque y en anonymize.js.
FEEDBACK_LEFTOVER_CI = re.compile(r'''[^ \t\r\n@]@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|(?:https?|ftp)://(?!(?:[a-z0-9-]+\.)*elffuss\.com/?[.,;:!?)\]'"»”]*(?:[ \t\r\n<>]|$))|(?<![a-z0-9.-])www\.[a-z0-9-]+\.[a-z]{2,}|/(?:users|home)/[a-z0-9._-]|[a-z]:\\(?:users|documents and settings)\\''', re.I | re.A)
FEEDBACK_LEFTOVER_CS = re.compile(r'''[0-9]{5,}|(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----''', re.A)
FEEDBACK_PLACEHOLDER = re.compile(r'\[[A-Z]+_[0-9]+\]')

_FB_KEYS = frozenset(('v', 'action', 'rated', 'app', 'build', 'model', 'lang', 'anonymizer', 'cut', 'messages'))
_FB_MESSAGE_KEYS = frozenset(('role', 'text', 'end'))
_FB_ENDS = ('stopped', 'cut', 'cutTool', 'stalled', 'noAnswer')
_FB_BUILD_RE = re.compile(r'[0-9A-Za-z._-]{1,40}')
_FB_MODEL_RE = re.compile(r'[a-z0-9][a-z0-9.-]{0,47}')
_FB_ANONYMIZER_RE = re.compile(r'[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}')
_FB_TOOL_RE = re.compile(r'\[tool(?:: [a-z]{1,20}\.[a-z]{1,20})?\]')
_FB_GAP_RE = re.compile(r'\[[1-9][0-9]{0,2} messages? left out\]')
_FB_BAD_CHAR_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]')   # C0 (salvo \t \n \r), DEL, surrogados sueltos
_FB_DIGITS_RE = re.compile(r'[0-9]+')
_FEEDBACK_LOCK = threading.Lock()   # una escritura (con su rotación y su poda) cada vez


class _FeedbackBadJSON(ValueError):
    """JSON que json.loads aceptaría y aquí no: claves repetidas, NaN, Infinity."""


class _FeedbackInsideRoot(Exception):
    """FEEDBACK_PATH cae dentro de ROOT, que el servidor estático sirve."""


def _fb_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise _FeedbackBadJSON('clave repetida')
        out[key] = value
    return out


def _fb_constant(name):
    raise _FeedbackBadJSON('NaN o Infinity')


def _fb_parse_int(text):
    # Convertir un entero de cientos de miles de cifras cuesta (y en Python
    # 3.11+ es un error); ninguno válido pasa de 6 cifras, así que uno largo
    # llega como float y lo rechaza el esquema.
    return int(text) if len(text) <= 20 else float(text)


def _fb_int(value, low, high):
    """Un entero de verdad dentro de [low, high]: ni True ni 1.0."""
    return type(value) is int and low <= value <= high


def _feedback_length(headers):
    """Content-Length → (bytes, None), o (None, (estado, código)) si falta, no
    es un número, vale 0 o pasa del tope. Por trozos (Transfer-Encoding) no."""
    values = headers.get_all('Content-Length') or []
    if headers.get('Transfer-Encoding') is not None or not values:
        return None, (411, 'length-required')
    text = values[0].strip(' \t')
    if len(values) != 1 or not _FB_DIGITS_RE.fullmatch(text):
        return None, (400, 'bad-length')
    digits = text.lstrip('0')
    if len(digits) > 7 or int(digits or '0') > FEEDBACK_MAX_BYTES:
        return None, (413, 'too-large')
    if not digits:
        return None, (400, 'bad-length')
    return int(digits), None


def _feedback_is_json(headers):
    """Content-Type application/json, con parámetros o sin ellos."""
    values = headers.get_all('Content-Type') or []
    return len(values) == 1 and values[0].split(';', 1)[0].strip().lower() == 'application/json'


def _feedback_rate_key(ip_text):
    """La clave del límite por cliente: la de _rate_key, salvo que una IPv6
    cuenta por su /56. Una casa suele recibir un /56 entero (256 /64): contada
    por /64, una sola conexión serían 256 clientes."""
    ip = _parse_ip(ip_text)
    if ip is not None and ip.version == 6 and ip.ipv4_mapped is None:
        return str(ipaddress.IPv6Network((int(ip) >> 72 << 72, 56)))
    return _rate_key(ip_text)


def _feedback_read(h, length, keep=True):
    """Lee exactamente length bytes del cuerpo con un plazo TOTAL de
    FEEDBACK_READ_TIMEOUT_S: el timeout del socket cuenta por lectura, y quien
    manda un byte cada pocos segundos lo esquivaría. → bytes, o None si el
    cuerpo llega corto o tarde. Con keep=False solo lo vacía."""
    deadline = time.monotonic() + FEEDBACK_READ_TIMEOUT_S
    read = getattr(h.rfile, 'read1', None) or h.rfile.read
    chunks, left = [], length
    try:
        while left > 0:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            h.connection.settimeout(remaining)
            chunk = read(min(left, 1 << 16))
            if not chunk:
                return None
            if keep:
                chunks.append(chunk)
            left -= len(chunk)
    except (OSError, ValueError):
        return None
    finally:
        try:
            h.connection.settimeout(FEEDBACK_READ_TIMEOUT_S)
        except OSError:
            pass
    return b''.join(chunks)


def _feedback_parse(body):
    """bytes → dict, o None si no es un objeto JSON en UTF-8 estricto."""
    try:
        data = json.loads(body.decode('utf-8'), object_pairs_hook=_fb_object,
                          parse_constant=_fb_constant, parse_int=_fb_parse_int)
    except (ValueError, RecursionError):   # UnicodeDecodeError y JSONDecodeError son ValueError
        return None
    return data if type(data) is dict else None


def _feedback_schema_error(p):
    """None si p cumple el esquema v1 y las reglas que el esquema no dice; si
    no, un motivo corto, que no sale ni en la respuesta ni en el log. Es lo
    mismo que validatePayload de feedback-payload.js menos la red de seguridad,
    que va aparte (_feedback_leftover: 422 y no 400)."""
    if set(p) != _FB_KEYS:
        return 'keys'
    if not _fb_int(p['v'], 1, 1):
        return 'v'
    action = p['action']
    if type(action) is not str or action not in ('like', 'dislike', 'report'):
        return 'action'
    if type(p['app']) is not str or p['app'] != 'chat':
        return 'app'
    if type(p['lang']) is not str or p['lang'] not in ('en', 'es'):
        return 'lang'
    if type(p['build']) is not str or not _FB_BUILD_RE.fullmatch(p['build']):
        return 'build'
    model = p['model']
    if model is not None and (type(model) is not str or not _FB_MODEL_RE.fullmatch(model)):
        return 'model'
    if type(p['anonymizer']) is not str or not _FB_ANONYMIZER_RE.fullmatch(p['anonymizer']):
        return 'anonymizer'
    cut = p['cut']
    if (type(cut) is not dict or set(cut) != {'dropped', 'shortened'}
            or not _fb_int(cut['dropped'], 0, 100_000) or not _fb_int(cut['shortened'], 0, 400)):
        return 'cut'
    messages = p['messages']
    if type(messages) is not list or not 1 <= len(messages) <= FEEDBACK_MAX_MESSAGES:
        return 'messages'
    for m in messages:
        if type(m) is not dict or 'role' not in m or 'text' not in m or not set(m) <= _FB_MESSAGE_KEYS:
            return 'message'
        role, text = m['role'], m['text']
        if type(role) is not str or role not in ('user', 'assistant', 'tool', 'gap'):
            return 'role'
        # Ni C0 (salvo \t \n \r), ni DEL, ni surrogados sueltos: lo mismo que
        # badChar de feedback-payload.js. Lo demás pasa, y _feedback_line lo
        # guarda escapado.
        if type(text) is not str or len(text) > FEEDBACK_MAX_TEXT or _FB_BAD_CHAR_RE.search(text):
            return 'text'
        if role == 'tool' and not _FB_TOOL_RE.fullmatch(text):
            return 'tool'
        if role == 'gap' and not _FB_GAP_RE.fullmatch(text):
            return 'gap'
        if 'end' in m and (role != 'assistant' or type(m['end']) is not str or m['end'] not in _FB_ENDS):
            return 'end'
    rated = p['rated']
    if action == 'report':
        if rated is not None:
            return 'rated'
    elif not _fb_int(rated, 0, len(messages) - 1) or messages[rated]['role'] != 'assistant':
        return 'rated'
    return None


def _feedback_leftover(text):
    """¿Queda en text algo con pinta de dato personal? Las etiquetas [TIPO_n]
    se tapan antes con espacios del mismo largo."""
    masked = FEEDBACK_PLACEHOLDER.sub(lambda m: ' ' * len(m.group()), text)
    return bool(FEEDBACK_LEFTOVER_CI.search(masked) or FEEDBACK_LEFTOVER_CS.search(masked))


def _feedback_inside_root(path):
    root = os.path.realpath(ROOT)
    where = os.path.realpath(path)
    return where == root or where.startswith(root.rstrip(os.sep) + os.sep)


def _feedback_today():   # las pruebas lo sustituyen
    return datetime.datetime.now(datetime.timezone.utc).date()


def _feedback_rotated(path):
    """Los ficheros ya rotados junto a path → [(día, ruta)]. Solo los que se
    llaman exactamente <nombre>-AAAA-MM-DD[.N]<extensión>: nada más se toca."""
    name = re.compile(re.escape(path.stem) + r'-([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\.[0-9]+)?' + re.escape(path.suffix))
    found = []
    try:
        with os.scandir(path.parent) as entries:
            for entry in entries:
                m = name.fullmatch(entry.name)
                if m and entry.is_file(follow_symlinks=False):
                    try:
                        found.append((datetime.date.fromisoformat(m.group(1)), Path(entry.path)))
                    except ValueError:
                        pass
    except (FileNotFoundError, NotADirectoryError):
        pass
    return found


def _feedback_tidy_locked(path):
    """Con _FEEDBACK_LOCK cogido: si el fichero activo es de un día UTC
    anterior a hoy, pasa a <nombre>-<ese día><extensión> (con .1, .2… si el
    nombre ya existe); luego borra los rotados de hace más de FEEDBACK_KEEP_DAYS."""
    today = _feedback_today()
    try:
        mtime = os.stat(path).st_mtime
    except (FileNotFoundError, NotADirectoryError):
        mtime = None
    if mtime is not None:
        day = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).date()
        if day < today:
            stamp, n = day.isoformat(), 0
            target = path.with_name('%s-%s%s' % (path.stem, stamp, path.suffix))
            while os.path.lexists(target):
                n += 1
                target = path.with_name('%s-%s.%d%s' % (path.stem, stamp, n, path.suffix))
            os.rename(path, target)
    for day, old in _feedback_rotated(path):
        if (today - day).days > FEEDBACK_KEEP_DAYS:
            try:
                old.unlink()
            except FileNotFoundError:
                pass


def _feedback_tidy():
    """Rotar y podar sin escribir nada. Dentro de ROOT no se toca nada."""
    path = Path(FEEDBACK_PATH)
    if _feedback_inside_root(path):
        return
    with _FEEDBACK_LOCK:
        _feedback_tidy_locked(path)


def _feedback_janitor():
    """Hilo de main() (solo de main(): las pruebas que importan este módulo no
    tocan ninguna carpeta de verdad). Rota y poda al arrancar y luego cada 6
    horas, para que los 90 días se cumplan aunque nadie mande nada."""
    while True:
        try:
            _feedback_tidy()
        except Exception as e:  # noqa: BLE001 — un fallo de disco no mata el hilo
            sys.stderr.write('· feedback: tidy failed (%s)\n' % type(e).__name__)
        time.sleep(FEEDBACK_TIDY_EVERY_S)


def _feedback_total(path):
    """Bytes de todos los <nombre>*<extensión> de la carpeta: el activo y los rotados."""
    total = 0
    with os.scandir(path.parent) as entries:
        for entry in entries:
            if (entry.name.startswith(path.stem) and entry.name.endswith(path.suffix)
                    and entry.is_file(follow_symlinks=False)):
                total += entry.stat(follow_symlinks=False).st_size
    return total


def _feedback_line(payload):
    """La línea que se guarda: el payload y nada más, en JSON compacto y en
    ASCII puro. Cualquier carácter que no es ASCII queda como \\uXXXX: los de
    control C1 (U+0080 a U+009F, que algunas terminales ejecutan: el título de
    la ventana, el portapapeles con OSC 52) y los que dan la vuelta al texto
    (U+202A a U+202E, U+2066 a U+2069) no llegan crudos a quien haga cat o tail
    del fichero, y json.loads devuelve el payload tal cual. Una «é» ocupa 6
    bytes en vez de 2 (un emoji, 12 en vez de 4): la línea mide como mucho el
    triple que el cuerpo, y los topes miden la línea."""
    return (json.dumps(payload, ensure_ascii=True, separators=(',', ':')) + '\n').encode('ascii')


def _feedback_store(line):
    """Anexa una línea (bytes) al fichero del día → True, o False si con ella
    se pasaría del tope del día o del total (503 full). Cualquier otro fallo es
    una excepción. La línea es ASCII puro (ver _feedback_line): un envío es una
    línea, y se lee igual con for line in f que con str.splitlines()."""
    path = Path(FEEDBACK_PATH)
    if _feedback_inside_root(path):
        raise _FeedbackInsideRoot()
    with _FEEDBACK_LOCK:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        _feedback_tidy_locked(path)
        try:
            size = os.stat(path).st_size
        except FileNotFoundError:
            size = 0
        if (size + len(line) > FEEDBACK_DAY_MAX_BYTES
                or _feedback_total(path) + len(line) > FEEDBACK_TOTAL_MAX_BYTES):
            return False
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
        fd = os.open(path, flags, 0o600)
        try:
            start = os.fstat(fd).st_size
            try:
                view = memoryview(line)
                while view:
                    done = os.write(fd, view)
                    if done <= 0:
                        raise OSError('os.write devolvió %d' % done)
                    view = view[done:]
            except BaseException:
                try:
                    os.ftruncate(fd, start)   # ni media línea en el fichero
                except OSError:
                    pass
                raise
        finally:
            os.close(fd)
    return True


def _feedback_ready():
    """Para la sonda, sin escribir nada: la carpeta existe o se puede crear, se
    puede escribir en ella y no cae dentro de ROOT."""
    path = Path(FEEDBACK_PATH)
    if _feedback_inside_root(path):
        return False
    folder = path.parent
    while not os.path.lexists(folder):
        if folder.parent == folder:
            return False
        folder = folder.parent
    if not folder.is_dir() or not os.access(folder, os.W_OK | os.X_OK):
        return False
    return not os.path.lexists(path) or (not path.is_symlink() and path.is_file() and os.access(path, os.W_OK))


def _feedback_is_probe(h):
    """La sonda de install-proxy.sh: X-Feedback-Probe: 1, desde loopback y SIN
    X-Forwarded-For. nginx pone siempre X-Forwarded-For en esta ruta, así que
    desde fuera nadie llega aquí."""
    return ((h.headers.get('X-Feedback-Probe') or '').strip() == '1'
            and _is_loopback(h.client_address[0])
            and h.headers.get('X-Forwarded-For') is None)


def _feedback_unlogged(h):
    """¿Es una petición a /proxy/feedback? Esas no dejan línea en el log: ni la
    de la petición (Handler.log_request) ni la de un fallo de la conexión
    (Handler.log_error). journald pone hora a cada línea y el fichero guarda
    los envíos en orden de llegada: la k-ésima línea del log de un día sería la
    k-ésima del fichero, y su hora, cruzada con el log de nginx, la IP de quien
    la mandó. Lo único que se escribe es «feedback: storage failed (<clase>)»,
    y entonces no se ha guardado nada."""
    return getattr(h, 'path', None) == '/proxy/feedback'


def _feedback_answer(h, status, error=None, retry_after=None):
    """Toda respuesta de /proxy/feedback: JSON fijo, nada de la entrada."""
    if status == 204:
        body = b''
    elif error:
        body = ('{"ok":false,"error":"%s"}' % error).encode('ascii')
    else:
        body = b'{"ok":true}'
    h.send_response(status)
    if status != 204:   # un 204 no lleva cuerpo ni Content-Length (RFC 9110, 8.6)
        h.send_header('Content-Type', 'application/json')
        h.send_header('Content-Length', str(len(body)))
    else:
        h.send_header('X-Feedback-Probe', 'ok')
    if error:
        h.send_header('X-Feedback-Error', error)
    if retry_after:
        h.send_header('Retry-After', str(retry_after))
    h.send_header('Connection', 'close')
    h._proxy_safety_headers()
    try:
        h.end_headers()
        if body:
            h.wfile.write(body)
    except OSError:
        # Quien preguntó ya no está (nginx cierra si el navegador se va). Sin
        # esto, socketserver escribiría la traza en stderr, con hora: justo lo
        # que _feedback_unlogged evita.
        h.close_connection = True


def _feedback_handle(h):
    """POST /proxy/feedback: las comprobaciones, en este orden."""
    h.close_connection = True
    try:
        h.connection.settimeout(FEEDBACK_READ_TIMEOUT_S)
    except OSError:
        pass
    length, length_error = _feedback_length(h.headers)

    def refuse(status, error, retry_after=None):
        # Un rechazo antes de leer: si la longitud es buena se vacía antes el
        # cuerpo (sin guardarlo), porque cerrar con datos sin leer manda un RST
        # y nginx podría perder la respuesta y contestar 502.
        if length is not None:
            _feedback_read(h, length, keep=False)
        return _feedback_answer(h, status, error, retry_after)

    if not h._proxy_caller_ok():                                     # 1. quién llama
        return refuse(403, 'cross-site')
    if not _feedback_is_json(h.headers):                             # 2. JSON
        return refuse(415, 'content-type')
    if length_error:                                                 # 3 y 4. longitud (413 sin leer)
        return _feedback_answer(h, *length_error)
    took = FEEDBACK_RATE.take(_feedback_rate_key(h.client_ip()))     # 5. por cliente, en memoria
    if took == 'limited':
        return refuse(429, 'rate-limited', FEEDBACK_RETRY_AFTER_S)
    # 6. Entre todos: aquí solo se mira, el cupo lo gasta un envío que pasa de
    # la 8 a la 10. Una tabla de clientes llena también es «demasiado».
    if took != 'ok' or FEEDBACK_GLOBAL_RATE.full('*'):
        return refuse(503, 'overloaded', FEEDBACK_RETRY_AFTER_S)
    body = _feedback_read(h, length)                                 # 7. el cuerpo, con plazo
    if body is None:
        return _feedback_answer(h, 400, 'bad-length')
    payload = _feedback_parse(body)                                  # 8. JSON estricto
    if payload is None:
        return _feedback_answer(h, 400, 'bad-json')
    try:                                                             # 9 y 10. esquema y red de seguridad
        bad = _feedback_schema_error(payload)
        leftover = bad is None and any(_feedback_leftover(m['text']) for m in payload['messages']
                                       if m['role'] in ('user', 'assistant'))
    except Exception:  # noqa: BLE001 — un fallo aquí es un rechazo, nunca un 500 que cuente nada
        bad, leftover = 'error', False
    if bad:
        return _feedback_answer(h, 400, 'schema')
    if leftover:
        return _feedback_answer(h, 422, 'leftover')
    if _feedback_is_probe(h):                                        # 11. la sonda no escribe ni gasta
        return _feedback_answer(h, 204) if _feedback_ready() else _feedback_answer(h, 500, 'storage')
    if not FEEDBACK_GLOBAL_RATE.allow('*'):                          # 6 bis. ahora sí, el cupo de todos
        return _feedback_answer(h, 503, 'overloaded', FEEDBACK_RETRY_AFTER_S)
    try:                                                             # 12. guardar
        stored = _feedback_store(_feedback_line(payload))
    except Exception as e:  # noqa: BLE001 — solo el nombre de la excepción: su texto lleva rutas
        h.log_message('feedback: storage failed (%s)', type(e).__name__)
        return _feedback_answer(h, 500, 'storage')
    if not stored:
        return _feedback_answer(h, 503, 'full')
    return _feedback_answer(h, 200)                                  # 13.
# ---- end /proxy/feedback ----


def _log_target(path):
    """Para el log, solo esquema y host del destino: la ruta y la query pueden
    llevar tokens, y lo que el usuario lee no tiene por qué quedar escrito."""
    try:
        url = (urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get('url') or [''])[0]
        parts = urllib.parse.urlsplit(url.strip())
        host = parts.hostname or ''
        shown = '%s://%s' % (parts.scheme, '[%s]' % host if ':' in host else host)
    except ValueError:
        shown = '?'
    return re.sub(r'[^A-Za-z0-9.:_\-\[\]/]', '?', shown)[:120]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/proxy?'):
            return self.proxy()
        if self.path.startswith('/v1/'):
            return self.forward_lm()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/v1/'):
            return self.forward_lm()
        if self.path == '/proxy/feedback':
            return self.feedback()
        self.send_error(404)

    def client_ip(self):
        """IP del cliente para los límites. Detrás de nginx la conexión llega
        SIEMPRE de 127.0.0.1, así que manda X-Forwarded-For, pero solo si lo
        pone alguien en loopback (nginx) y tomando la ÚLTIMA entrada: con
        $proxy_add_x_forwarded_for las anteriores las escribe el propio cliente."""
        peer = self.client_address[0]
        xff = self.headers.get('X-Forwarded-For') or ''
        if xff.strip() and _is_loopback(peer):
            last = xff.split(',')[-1].strip()
            if last:
                return last[:64]
        return peer

    def forward_lm(self):
        """Reenvía /v1/* (API del modelo) al servidor de producción, con streaming."""
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            LM_UPSTREAM + self.path, data=body, method=self.command,
            headers={'Content-Type': self.headers.get('Content-Type', 'application/json')})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                self.send_response(r.status)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self.end_headers()
                while True:
                    chunk = r.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f'lm: {e}')

    def _proxy_caller_ok(self):
        """Solo la propia página (fetch del mismo origen) o un cliente que no es
        un navegador (curl, el chequeo de salud). Fuera navegaciones, iframes,
        <img>/<script> y cualquier otro origen: así una web ajena no usa este
        servidor de proxy ni abre aquí HTML de terceros con nuestro origen."""
        site = (self.headers.get('Sec-Fetch-Site') or '').strip().lower()
        dest = (self.headers.get('Sec-Fetch-Dest') or '').strip().lower()
        if site not in ('', 'same-origin') or dest not in ('', 'empty'):
            return False
        origin = self.headers.get('Origin')
        if origin is not None:
            host = (self.headers.get('Host') or '').strip().lower()
            try:
                return urllib.parse.urlsplit(origin.strip()).netloc.lower() == host
            except ValueError:
                return False
        return True

    def _proxy_safety_headers(self):
        # Lo que sale de aquí es contenido de TERCEROS servido con NUESTRO
        # origen: si alguien abre /proxy?url=<su html> como página, el sandbox
        # sin scripts le quita el origen y no ejecuta nada. Sin CORS: la app lo
        # pide desde su mismo origen y ninguna otra web tiene por qué leerlo.
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Referrer-Policy', 'no-referrer')

    def _proxy_fail(self, status, code, detail, retry_after=None):
        body = (detail + '\n').encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Proxy-Error', code)
        if retry_after:
            self.send_header('Retry-After', str(retry_after))
        self._proxy_safety_headers()
        self.end_headers()
        self.wfile.write(body)

    def proxy(self):
        if not PROXY_RATE.allow(_rate_key(self.client_ip())):
            return self._proxy_fail(429, 'rate-limited', 'demasiadas peticiones al proxy, espera un poco',
                                    retry_after=PROXY_RATE_WINDOW_S)
        if not self._proxy_caller_ok():
            return self._proxy_fail(403, 'cross-site', 'el proxy solo atiende a la propia app')
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        url = (qs.get('url') or [''])[0]
        if not PROXY_SLOTS.acquire(blocking=False):
            return self._proxy_fail(503, 'busy', 'proxy ocupado, prueba en unos segundos', retry_after=5)
        try:
            res = proxy_fetch(url)
        except ProxyRefused as e:
            return self._proxy_fail(e.status, e.code, e.detail)
        finally:
            PROXY_SLOTS.release()
        body = b'' if res.status in (204, 205) else res.body
        self.send_response(res.status)
        self.send_header('Content-Type', res.content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Proxy-Truncated', '1' if res.truncated else '0')
        self.send_header('X-Proxy-Upstream-Status', str(res.upstream_status))
        self._proxy_safety_headers()
        self.end_headers()
        self.wfile.write(body)

    def feedback(self):
        return _feedback_handle(self)

    def log_request(self, code='-', size='-'):
        if _feedback_unlogged(self):
            return
        if isinstance(code, HTTPStatus):
            code = code.value
        line = self.requestline
        path = getattr(self, 'path', '') or ''
        if path.startswith('/proxy?'):
            line = '%s /proxy?url=%s' % (self.command, _log_target(path))
        self.log_message('"%s" %s %s', line, str(code), str(size))

    def log_error(self, fmt, *args):
        if _feedback_unlogged(self):
            return
        super().log_error(fmt, *args)

    def log_message(self, fmt, *args):
        sys.stderr.write('· %s\n' % (fmt % args))


def main(argv=None):
    argv = sys.argv if argv is None else argv
    port = int(argv[1]) if len(argv) > 1 else 8642
    # Solo loopback salvo que se pida: en local basta localhost, y abrirlo a la
    # red expone también el proxy a cualquiera que llegue a este puerto.
    bind = os.environ.get('ELFFUSS_BIND', '127.0.0.1')
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((bind, port), Handler) as httpd:
        print(f'✳ Elffuss Code · http://localhost:{port}')
        threading.Thread(target=_feedback_janitor, name='feedback-janitor', daemon=True).start()
        httpd.serve_forever()


if __name__ == '__main__':
    main()
