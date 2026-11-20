#!/usr/bin/env python3
"""Pruebas de POST /proxy/feedback de server/serve.py: las valoraciones y los
avisos del chat de elffuss.com, que llegan ya anonimizados del navegador.

El mismo fichero en elffuss-claw y en elffuss-code, como el bloque de serve.py
que prueba. Sin red: el servidor escucha en un puerto libre de 127.0.0.1 y
guarda en una carpeta temporal (FEEDBACK_PATH sustituido), así que nada toca la
carpeta de verdad. Los casos del esquema y de la red de seguridad son los de
tests/fixtures/feedback-payloads.json y tests/fixtures/leftover-cases.json,
los mismos que usa el chat.

    python3 tests/test_feedback.py
"""
import datetime
import errno
import http.client
import importlib.util
import io
import json
import os
import shutil
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True   # que la prueba no deje __pycache__ junto a serve.py
HERE = Path(__file__).resolve().parent
SERVE_PY = HERE.parent / 'server' / 'serve.py'
_spec = importlib.util.spec_from_file_location('elffuss_serve_feedback', SERVE_PY)
serve = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(serve)

PAYLOADS = json.loads((HERE / 'fixtures' / 'feedback-payloads.json').read_text(encoding='utf-8'))
LEFTOVER_CASES = json.loads((HERE / 'fixtures' / 'leftover-cases.json').read_text(encoding='utf-8'))
EXAMPLE = PAYLOADS['valid'][0]['payload']   # el «no me gusta» de ejemplo de la especificación
# Lo que manda server/proxy-probe.py --feedback.
PROBE_BODY = (b'{"v":1,"action":"report","rated":null,"app":"chat","build":"probe","model":null,"lang":"en",'
              b'"anonymizer":"0.0.0","cut":{"dropped":0,"shortened":0},"messages":[{"role":"user","text":"probe"}]}')
BROWSER = ('Origin', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest')


def body_of(payload):
    """Como lo manda el chat: JSON.stringify(payload, null, 2), en UTF-8."""
    return json.dumps(payload, ensure_ascii=False, indent=2).encode('utf-8')


def stored_line(payload):
    """La línea que tiene que quedar en el fichero: el payload y nada más, en ASCII."""
    return (json.dumps(payload, ensure_ascii=True, separators=(',', ':')) + '\n').encode('ascii')


def sized(n):
    """Un aviso válido cuyo cuerpo mide exactamente n bytes."""
    p = {'v': 1, 'action': 'report', 'rated': None, 'app': 'chat', 'build': 'dev', 'model': None, 'lang': 'en',
         'anonymizer': '1.0.0', 'cut': {'dropped': 0, 'shortened': 0},
         'messages': [{'role': 'user', 'text': ''} for _ in range(4)]}
    need = n - len(body_of(p))
    for m in p['messages']:
        m['text'] = 'a' * (need // 4)
    p['messages'][0]['text'] += 'a' * (need % 4)
    assert len(body_of(p)) == n
    return p


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


class FeedbackCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='elffuss-feedback-'))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / 'web'            # lo que sirve el servidor estático
        self.root.mkdir()
        self.dir = self.tmp / 'datos'           # no existe todavía: la crea el servidor, 0700
        self.path = self.dir / 'feedback.jsonl'
        self.err = io.StringIO()                # todo lo que el servidor escribe en stderr
        for target, name, value in ((serve, 'FEEDBACK_PATH', str(self.path)),
                                    (serve, 'ROOT', str(self.root)),
                                    (serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 10_000)),
                                    (serve, 'FEEDBACK_GLOBAL_RATE', serve._FeedbackLimiter(3600, 10_000)),
                                    (serve.sys, 'stderr', self.err)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.server = _Server(('127.0.0.1', 0), serve.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def send(self, body=b'', headers=None, omit=(), also=(), length=True, path='/proxy/feedback', method='POST'):
        """Una petición con las cabeceras de un fetch del mismo origen, como la
        del chat → (estado, cabeceras en minúsculas, cuerpo). length=None no
        manda Content-Length; un texto lo manda tal cual (sin cuerpo detrás)."""
        sent = {'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:%d' % self.port,
                'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}
        if length is True:
            sent['Content-Length'] = str(len(body))
        elif length is not None:
            sent['Content-Length'] = str(length)
        sent.update(headers or {})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            conn.putrequest(method, path, skip_accept_encoding=True)
            for name, value in list(sent.items()) + list(also):
                if name not in omit:
                    conn.putheader(name, value)
            conn.endheaders(body or None)
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()

    def post(self, payload, **kwargs):
        return self.send(body_of(payload), **kwargs)

    def raw(self, data, half_close=False):
        """Bytes tal cual por un socket → (estado, cuerpo)."""
        with socket.create_connection(('127.0.0.1', self.port), timeout=30) as s:
            s.sendall(data)
            if half_close:
                s.shutdown(socket.SHUT_WR)
            reply = b''
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                reply += chunk
        head, _, body = reply.partition(b'\r\n\r\n')
        return int(head.split(b' ', 2)[1]), body

    def head(self, length):
        return ('POST /proxy/feedback HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\n'
                'Content-Length: %d\r\n\r\n' % (self.port, length)).encode('ascii')

    def lines(self):
        """Las líneas guardadas (partiendo solo por \\n, como un lector de .jsonl)."""
        if not self.path.exists():
            return []
        return [line.decode('utf-8') for line in self.path.read_bytes().split(b'\n') if line]

    def assertAnswer(self, got, status, error=None):
        """Toda respuesta: el estado, el JSON fijo y las cabeceras de siempre."""
        code, hdrs, body = got
        self.assertEqual(code, status, body[:300])
        if error is None:
            self.assertEqual(body, b'{"ok":true}')
            self.assertNotIn('x-feedback-error', hdrs)
        else:
            self.assertEqual(body, ('{"ok":false,"error":"%s"}' % error).encode('ascii'))
            self.assertEqual(hdrs.get('x-feedback-error'), error)
        self.assertEqual(hdrs.get('content-type'), 'application/json')
        self.assertEqual(hdrs.get('content-length'), str(len(body)))
        self.assertEqual(hdrs.get('x-content-type-options'), 'nosniff')
        self.assertTrue(hdrs.get('content-security-policy', '').startswith('sandbox;'), hdrs)
        self.assertEqual(hdrs.get('cross-origin-resource-policy'), 'same-origin')
        self.assertEqual(hdrs.get('referrer-policy'), 'no-referrer')
        self.assertEqual(hdrs.get('cache-control'), 'no-store')
        self.assertNotIn('access-control-allow-origin', hdrs)


class Accepts(FeedbackCase):
    def test_a_valid_post_is_stored_as_sent_and_nothing_about_who_sent_it(self):
        got = self.post(EXAMPLE, headers={'X-Forwarded-For': '198.51.100.77', 'User-Agent': 'AgenteDePrueba/7.7'})
        self.assertAnswer(got, 200)
        self.assertEqual(self.path.read_bytes(), stored_line(EXAMPLE), 'una línea, el payload y nada más')
        stored = json.loads(self.path.read_bytes())
        self.assertEqual(list(stored), list(EXAMPLE), 'ni una clave de más (ni hora, ni IP, ni User-Agent)')
        everything = self.path.read_text(encoding='utf-8') + self.err.getvalue()
        for trace in ('198.51.100.77', 'AgenteDePrueba'):
            self.assertNotIn(trace, everything)
        # Ni la línea de la petición: con la hora que le pone journald, y las
        # líneas guardadas en orden de llegada, diría cuál mandó quién.
        self.assertEqual(self.err.getvalue(), '', 'un envío guardado no deja nada en el log')
        self.assertEqual(os.listdir(self.dir), ['feedback.jsonl'])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.dir.stat().st_mode), 0o700)

    def test_every_valid_fixture_is_accepted(self):
        for entry in PAYLOADS['valid']:
            with self.subTest(entry['name']):
                self.assertAnswer(self.post(entry['payload']), 200)
        self.assertEqual([json.loads(line) for line in self.lines()], [e['payload'] for e in PAYLOADS['valid']])

    def test_the_body_cap_is_inclusive(self):
        payload = sized(serve.FEEDBACK_MAX_BYTES)
        self.assertAnswer(self.post(payload), 200)
        self.assertEqual(self.path.read_bytes(), stored_line(payload))

    def test_a_text_can_have_65536_characters(self):
        payload = json.loads(json.dumps(EXAMPLE))
        payload['messages'][0]['text'] = 'a' * serve.FEEDBACK_MAX_TEXT
        self.assertAnswer(self.post(payload), 200)

    def test_json_with_parameters_or_in_capitals_is_json(self):
        for ctype in ('application/json; charset=utf-8', 'Application/JSON', 'application/json ;charset=UTF-8'):
            with self.subTest(ctype=ctype):
                self.assertAnswer(self.post(EXAMPLE, headers={'Content-Type': ctype}), 200)

    def test_a_client_that_is_not_a_browser_is_served(self):
        # Como en /proxy: Sec-Fetch-* y Origin frenan a OTRAS webs que usen el
        # navegador de alguien; quien no es un navegador no los manda.
        self.assertAnswer(self.post(EXAMPLE, omit=BROWSER), 200)

    def test_twenty_posts_at_once_give_twenty_whole_lines(self):
        payloads = [dict(EXAMPLE, build='p%d' % i) for i in range(20)]
        statuses = [None] * 20

        def go(i):
            statuses[i] = self.post(payloads[i], headers={'X-Forwarded-For': '192.0.2.%d' % (100 + i)})[0]
        threads = [threading.Thread(target=go, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(statuses, [200] * 20)
        lines = self.lines()
        self.assertEqual(len(lines), 20)
        self.assertEqual(sorted(json.loads(line)['build'] for line in lines), sorted(p['build'] for p in payloads))


class Refuses(FeedbackCase):
    def test_other_sites_are_refused_first_and_use_up_no_quota(self):
        with mock.patch.object(serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 2)):
            for headers in ({'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'same-site'},
                            {'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain'},
                            {'Origin': 'https://evil.example'}, {'Origin': 'null'},
                            {'Sec-Fetch-Dest': 'document'}, {'Sec-Fetch-Dest': 'iframe'}):
                headers['X-Forwarded-For'] = '192.0.2.50'
                with self.subTest(headers=headers):
                    self.assertAnswer(self.post(EXAMPLE, headers=headers), 403, 'cross-site')
            # Siete rechazos, y el cupo de esa persona (2) sigue entero.
            for _ in range(2):
                self.assertAnswer(self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.50'}), 200)
        self.assertEqual(len(self.lines()), 2)

    def test_only_json(self):
        for ctype in ('text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded',
                      'multipart/form-data; boundary=x', 'application/jsonx', 'application/json-patch+json', ''):
            with self.subTest(ctype=ctype):
                self.assertAnswer(self.post(EXAMPLE, headers={'Content-Type': ctype}), 415, 'content-type')
        self.assertAnswer(self.post(EXAMPLE, omit=('Content-Type',)), 415, 'content-type')
        self.assertFalse(self.dir.exists())

    def test_the_length_must_be_declared_and_sane(self):
        # Sin cuerpo detrás: el servidor contesta sin leer nada.
        self.assertAnswer(self.send(length=None), 411, 'length-required')
        self.assertAnswer(self.send(length=None, headers={'Transfer-Encoding': 'chunked'}), 411, 'length-required')
        self.assertAnswer(self.send(length=5, headers={'Transfer-Encoding': 'chunked'}), 411, 'length-required')
        for value in ('abc', '-5', '0', '000', '1.5', '+5', '', '5 5', '0x10'):
            with self.subTest(value=value):
                self.assertAnswer(self.send(length=value), 400, 'bad-length')
        self.assertAnswer(self.send(length=5, also=[('Content-Length', '5')]), 400, 'bad-length')
        for value in (serve.FEEDBACK_MAX_BYTES + 1, 300_000, 99_999_999_999):
            with self.subTest(value=value):
                self.assertAnswer(self.send(length=value), 413, 'too-large')
        self.assertFalse(self.dir.exists())

    def test_too_large_is_refused_before_reading_the_body(self):
        with mock.patch.object(serve, 'FEEDBACK_READ_TIMEOUT_S', 30):
            started = time.monotonic()
            # Solo las cabeceras: un servidor que esperase el cuerpo tardaría 30 s.
            self.assertAnswer(self.send(length=serve.FEEDBACK_MAX_BYTES + 1), 413, 'too-large')
            self.assertLess(time.monotonic() - started, 10)

    def test_a_body_that_ends_short_or_late_is_bad_length(self):
        status, body = self.raw(self.head(100) + b'{"v": 1', half_close=True)
        self.assertEqual((status, body), (400, b'{"ok":false,"error":"bad-length"}'))
        with mock.patch.object(serve, 'FEEDBACK_READ_TIMEOUT_S', 1):
            started = time.monotonic()
            status, body = self.raw(self.head(100) + b'{"v": 1')
            self.assertLess(time.monotonic() - started, 10)
        self.assertEqual((status, body), (400, b'{"ok":false,"error":"bad-length"}'))
        self.assertFalse(self.dir.exists())

    def test_only_strict_json_objects(self):
        good = body_of(EXAMPLE)
        cases = {
            'cut-short': good[:-5],
            'trailing-garbage': good + b'x',
            'two-objects': good + good,
            'duplicate-key': good.replace(b'"v": 1,', b'"v": 1,\n  "v": 1,', 1),
            'duplicate-key-in-a-message': good.replace(b'"role": "tool",', b'"role": "tool", "role": "tool",', 1),
            'nan': good.replace(b'"v": 1,', b'"v": NaN,', 1),
            'infinity': good.replace(b'"v": 1,', b'"v": Infinity,', 1),
            'minus-infinity': good.replace(b'"v": 1,', b'"v": -Infinity,', 1),
            'not-utf-8': good.replace('Según'.encode('utf-8'), b'Seg\xfan', 1),
            'utf-8-bom': b'\xef\xbb\xbf' + good,
            'array': b'[' + good + b']',
            'string': b'"hola"',
            'number': b'1',
            'deep-nesting': b'{"v": ' + b'[' * 100_000 + b']' * 100_000 + b'}',
        }
        for name, body in cases.items():
            with self.subTest(name):
                self.assertNotEqual(body, good)
                self.assertAnswer(self.send(body), 400, 'bad-json')
        self.assertFalse(self.dir.exists())

    def test_every_invalid_fixture_is_refused_and_nothing_is_written(self):
        for entry in PAYLOADS['invalid']:
            with self.subTest(entry['name']):
                # ensure_ascii: el surrogado suelto viaja como \ud800, como lo escapa JSON.stringify.
                got = self.send(json.dumps(entry['payload']).encode('ascii'))
                if entry['expect'] == 'leftover':
                    self.assertAnswer(got, 422, 'leftover')
                else:
                    self.assertAnswer(got, 400, 'schema')
        self.assertFalse(self.dir.exists(), 'ni la carpeta')

    def test_numbers_must_be_real_integers(self):
        good = json.dumps(EXAMPLE)
        for old, new in (('"v": 1,', '"v": 1.0,'), ('"v": 1,', '"v": 1e0,'), ('"rated": 3,', '"rated": 3.0,'),
                         ('"v": 1,', '"v": %s,' % ('1' * 300)), ('"dropped": 0,', '"dropped": 0.0,')):
            with self.subTest(new=new[:20]):
                self.assertAnswer(self.send(good.replace(old, new, 1).encode('utf-8')), 400, 'schema')
        self.assertFalse(self.dir.exists())

    def test_a_text_over_65536_characters_is_refused(self):
        payload = json.loads(json.dumps(EXAMPLE))
        payload['messages'][0]['text'] = 'a' * (serve.FEEDBACK_MAX_TEXT + 1)
        self.assertAnswer(self.post(payload), 400, 'schema')

    def test_answers_never_echo_what_was_sent(self):
        marker = 'MARCADEPRUEBA'
        payload = dict(EXAMPLE, extra=marker)
        leftover = json.loads(json.dumps(EXAMPLE))
        leftover['messages'][0]['text'] = 'escribe a %s@correo.es' % marker
        for body in (json.dumps(payload).encode('ascii'), json.dumps(leftover).encode('ascii'),
                     b'{"%s": ' % marker.encode('ascii')):
            with self.subTest(body=body[:30]):
                status, hdrs, answer = self.send(body)
                self.assertIn(status, (400, 422))
                self.assertNotIn(marker.encode('ascii'), answer)
                self.assertNotIn(marker, ' '.join(hdrs.values()))
        self.assertNotIn(marker, self.err.getvalue())

    def test_refusals_leave_nothing_in_the_log_either(self):
        leftover = json.loads(json.dumps(EXAMPLE))
        leftover['messages'][0]['text'] = 'escribe a ana@correo.es'
        with mock.patch.object(serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 1)):
            got = [self.post(EXAMPLE, headers={'Sec-Fetch-Site': 'cross-site'})[0],
                   self.post(EXAMPLE, headers={'Content-Type': 'text/plain'})[0],
                   self.send(length=None)[0], self.send(length='abc')[0],
                   self.send(length=serve.FEEDBACK_MAX_BYTES + 1)[0],
                   self.send(b'{"v": 1}', headers={'X-Forwarded-For': '192.0.2.1'})[0],
                   self.send(b'{"v": 1}', headers={'X-Forwarded-For': '192.0.2.1'})[0],
                   self.post(leftover, headers={'X-Forwarded-For': '192.0.2.2'})[0],
                   self.send(b'{', headers={'X-Forwarded-For': '192.0.2.3'})[0]]
        self.assertEqual(got, [403, 415, 411, 400, 413, 400, 429, 422, 400])
        self.assertEqual(self.err.getvalue(), '')

    def test_only_post_to_the_exact_path(self):
        for path in ('/proxy/feedback?x=1', '/proxy/feedback/', '/proxy/feedbacks', '/proxy/Feedback'):
            with self.subTest(path=path):
                self.assertEqual(self.send(path=path)[0], 404)
        self.assertEqual(self.send(method='OPTIONS', length=None,
                                   headers={'Access-Control-Request-Method': 'POST'})[0], 501)
        self.assertFalse(self.dir.exists())


class Limits(FeedbackCase):
    def test_each_client_has_a_quota_kept_only_in_memory(self):
        with mock.patch.object(serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 2)):
            first = [self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.10'})[0] for _ in range(2)]
            third = self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.10'})
            # Cuenta la última entrada (la que pone nginx), no las que escribe el cliente.
            forged = self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.99, 192.0.2.10'})
            other = self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.11'})
        self.assertEqual(first, [200, 200])
        self.assertAnswer(third, 429, 'rate-limited')
        self.assertEqual(third[1].get('retry-after'), '600')
        self.assertAnswer(forged, 429, 'rate-limited')
        self.assertAnswer(other, 200)
        self.assertEqual(len(self.lines()), 3)
        everything = self.path.read_text(encoding='utf-8') + self.err.getvalue()
        for ip in ('192.0.2.10', '192.0.2.11', '192.0.2.99'):
            self.assertNotIn(ip, everything)

    def test_ipv6_clients_share_their_56(self):
        # Una casa suele tener un /56 entero: sus 256 /64 son el mismo cliente.
        with mock.patch.object(serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 2)):
            got = [self.post(EXAMPLE, headers={'X-Forwarded-For': ip})[0]
                   for ip in ('2001:db8:1:200::1', '2001:db8:1:2ff:ffff::9', '2001:db8:1:2ab::5', '2001:db8:1:300::1')]
        self.assertEqual(got, [200, 200, 429, 200])

    def test_a_global_limit_across_every_client(self):
        with mock.patch.object(serve, 'FEEDBACK_GLOBAL_RATE', serve._FeedbackLimiter(3600, 2)):
            answers = [self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.%d' % (20 + i)}) for i in range(3)]
        self.assertEqual([a[0] for a in answers[:2]], [200, 200])
        self.assertAnswer(answers[2], 503, 'overloaded')
        self.assertEqual(answers[2][1].get('retry-after'), '600')
        self.assertEqual(len(self.lines()), 2)

    def test_junk_does_not_spend_the_budget_of_everyone(self):
        # Antes, cuatro IPv4 mandando solo cabeceras dejaban a todos en 503
        # overloaded. El cupo de todos lo gasta solo un envío que se guardaría.
        leftover = json.loads(json.dumps(EXAMPLE))
        leftover['messages'][0]['text'] = 'escribe a ana@correo.es'
        junk = [b'{', b'{"v": 1}', body_of(leftover), b'x' * 100, json.dumps([EXAMPLE]).encode('ascii')]
        with mock.patch.object(serve, 'FEEDBACK_GLOBAL_RATE', serve._FeedbackLimiter(3600, 2)):
            got = [self.send(body, headers={'X-Forwarded-For': '192.0.2.%d' % (30 + i)})[0]
                   for i, body in enumerate(junk * 4)]
            # Una sonda tampoco gasta: no guarda nada.
            self.assertEqual(self.send(PROBE_BODY, headers={'X-Feedback-Probe': '1'}, omit=BROWSER)[0], 204)
            answers = [self.post(EXAMPLE, headers={'X-Forwarded-For': '192.0.2.%d' % (60 + i)}) for i in range(3)]
        self.assertEqual(got, [400, 400, 422, 400, 400] * 4)
        self.assertEqual([a[0] for a in answers[:2]], [200, 200])
        self.assertAnswer(answers[2], 503, 'overloaded')
        self.assertEqual(len(self.lines()), 2)

    def test_with_no_budget_left_a_post_is_refused_before_it_is_parsed(self):
        with mock.patch.object(serve, 'FEEDBACK_GLOBAL_RATE', serve._FeedbackLimiter(3600, 1)):
            self.assertAnswer(self.post(EXAMPLE), 200)
            with mock.patch.object(serve, '_feedback_parse', side_effect=AssertionError('leído')):
                self.assertAnswer(self.post(EXAMPLE), 503, 'overloaded')
        self.assertEqual(len(self.lines()), 1)

    def test_a_full_table_of_clients_is_overloaded_and_known_clients_go_on(self):
        with mock.patch.object(serve, 'FEEDBACK_RATE', serve._FeedbackLimiter(600, 10, max_keys=2)):
            got = [self.post(EXAMPLE, headers={'X-Forwarded-For': ip}) for ip in
                   ('192.0.2.1', '2001:db8:1:200::1', '192.0.2.3', '2001:db8:1:2ff::1', '192.0.2.1')]
        self.assertEqual([g[0] for g in got], [200, 200, 503, 200, 200])
        self.assertAnswer(got[2], 503, 'overloaded')
        self.assertEqual(got[2][1].get('retry-after'), '600')
        self.assertEqual(len(self.lines()), 4)


class Storage(FeedbackCase):
    TODAY = datetime.date(2026, 11, 20)

    def rotated(self, days_ago, extra=''):
        return 'feedback-%s%s.jsonl' % ((self.TODAY - datetime.timedelta(days=days_ago)).isoformat(), extra)

    def test_a_current_active_file_is_appended_to(self):
        self.assertAnswer(self.post(EXAMPLE), 200)
        self.assertAnswer(self.post(EXAMPLE), 200)
        self.assertEqual(self.path.read_bytes(), stored_line(EXAMPLE) * 2)
        self.assertEqual(os.listdir(self.dir), ['feedback.jsonl'])

    def test_a_stale_active_file_is_rotated_to_its_day(self):
        self.dir.mkdir(mode=0o700)
        self.path.write_bytes(b'{"old":1}\n')
        then = time.time() - 86400
        os.utime(self.path, (then, then))
        day = datetime.datetime.fromtimestamp(then, datetime.timezone.utc).date().isoformat()
        self.assertAnswer(self.post(EXAMPLE), 200)
        self.assertEqual((self.dir / ('feedback-%s.jsonl' % day)).read_bytes(), b'{"old":1}\n')
        self.assertEqual(self.path.read_bytes(), stored_line(EXAMPLE))

    def test_a_rotated_name_already_taken_gets_a_number(self):
        self.dir.mkdir(mode=0o700)
        then = time.time() - 86400
        day = datetime.datetime.fromtimestamp(then, datetime.timezone.utc).date().isoformat()
        (self.dir / ('feedback-%s.jsonl' % day)).write_bytes(b'first\n')
        self.path.write_bytes(b'second\n')
        os.utime(self.path, (then, then))
        self.assertAnswer(self.post(EXAMPLE), 200)
        self.assertEqual((self.dir / ('feedback-%s.jsonl' % day)).read_bytes(), b'first\n')
        self.assertEqual((self.dir / ('feedback-%s.1.jsonl' % day)).read_bytes(), b'second\n')

    def prune_fixture(self):
        self.dir.mkdir(mode=0o700)
        old = [self.rotated(91), self.rotated(91, '.1'), self.rotated(400)]
        kept = [self.rotated(90), self.rotated(1), 'reports.jsonl', 'feedback-notes.txt',
                self.rotated(200) + '.bak', 'feedback-2026-02-30.jsonl', 'otro-' + self.rotated(200)]
        for name in old + kept:
            (self.dir / name).write_bytes(b'x\n')
        return kept

    def test_the_janitor_prunes_files_older_than_90_days_and_nothing_else(self):
        kept = self.prune_fixture()
        with mock.patch.object(serve, '_feedback_today', lambda: self.TODAY):
            serve._feedback_tidy()   # lo que hace el hilo de main() aunque nadie mande nada
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(kept))

    def test_a_post_also_prunes(self):
        kept = self.prune_fixture()
        with mock.patch.object(serve, '_feedback_today', lambda: self.TODAY):
            self.assertAnswer(self.post(EXAMPLE), 200)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(kept + ['feedback.jsonl']))

    def test_the_stored_line_is_pure_ascii_and_reads_back_the_same(self):
        # Controles C1 (CSI, OSC … ST: una terminal los ejecutaría con cat o
        # tail), los que dan la vuelta al texto, U+2028 y U+2029, y letras.
        tricky = ('C1 \u0085 \u009b31m \u009d0;título\u009c, bidi ‮abc‬ ⁦x⁩, '
                  'líneas    , emoji \U0001F600, ñ é ¿?')
        payload = json.loads(json.dumps(EXAMPLE))
        payload['messages'][0]['text'] = tricky
        self.assertAnswer(self.post(payload), 200)
        raw = self.path.read_bytes()
        self.assertTrue(raw.isascii(), 'ni un byte por encima de 0x7f')
        self.assertEqual(raw.count(b'\n'), 1)
        for ch in '\u0085\u009b\u009d\u009c‮‬⁦⁩  ':
            self.assertIn(b'\\u%04x' % ord(ch), raw)
        self.assertEqual(raw, stored_line(payload))
        self.assertEqual(json.loads(raw), payload, 'json.loads devuelve lo que se mandó')
        self.assertEqual(raw.decode('ascii').splitlines(), [raw.decode('ascii').rstrip('\n')])

    @unittest.skipIf('ELFFUSS_FEEDBACK_DAYS' in os.environ, 'el tope del día depende de ELFFUSS_FEEDBACK_DAYS')
    def test_the_daily_cap_measures_the_escaped_line_and_holds_two_of_the_worst(self):
        # La peor línea: un cuerpo del tope lleno de «é» (2 bytes, 6 al escaparla).
        payload = sized(serve.FEEDBACK_MAX_BYTES)
        for m in payload['messages']:
            m['text'] = 'é' * (len(m['text']) // 2)
        body = body_of(payload)
        self.assertLessEqual(len(body), serve.FEEDBACK_MAX_BYTES)
        line = len(stored_line(payload))
        self.assertGreater(line, 2.9 * len(body))
        self.assertLessEqual(line, 3 * len(body))
        self.assertAnswer(self.send(body), 200)
        self.assertAnswer(self.send(body), 200)
        self.assertLessEqual(2 * line, serve.FEEDBACK_DAY_MAX_BYTES)
        self.assertGreater(3 * line, serve.FEEDBACK_DAY_MAX_BYTES)
        self.assertAnswer(self.send(body), 503, 'full')
        self.assertEqual(self.path.stat().st_size, 2 * line)

    def test_the_daily_cap_answers_full_and_writes_nothing(self):
        self.assertAnswer(self.post(EXAMPLE), 200)
        before = self.path.read_bytes()
        line = len(stored_line(EXAMPLE))
        with mock.patch.object(serve, 'FEEDBACK_DAY_MAX_BYTES', len(before) + line - 1):
            self.assertAnswer(self.post(EXAMPLE), 503, 'full')
        self.assertEqual(self.path.read_bytes(), before)
        with mock.patch.object(serve, 'FEEDBACK_DAY_MAX_BYTES', len(before) + line):
            self.assertAnswer(self.post(EXAMPLE), 200)

    def test_the_total_cap_counts_the_rotated_files_and_answers_full(self):
        self.dir.mkdir(mode=0o700)
        (self.dir / self.rotated(19)).write_bytes(b'x' * 1000)
        (self.dir / 'reports.jsonl').write_bytes(b'y' * 5000)   # no es de aquí: no cuenta
        line = len(stored_line(EXAMPLE))
        with mock.patch.object(serve, '_feedback_today', lambda: self.TODAY):
            with mock.patch.object(serve, 'FEEDBACK_TOTAL_MAX_BYTES', 1000 + line - 1):
                self.assertAnswer(self.post(EXAMPLE), 503, 'full')
            self.assertFalse(self.path.exists())
            with mock.patch.object(serve, 'FEEDBACK_TOTAL_MAX_BYTES', 1000 + line):
                self.assertAnswer(self.post(EXAMPLE), 200)

    def test_a_folder_that_cannot_be_created_is_a_500_without_paths(self):
        blocker = self.tmp / 'bloqueo'
        blocker.write_text('un fichero, no una carpeta', encoding='utf-8')
        with mock.patch.object(serve, 'FEEDBACK_PATH', str(blocker / 'feedback.jsonl')):
            self.assertAnswer(self.post(EXAMPLE), 500, 'storage')
        log = self.err.getvalue()
        self.assertIn('· feedback: storage failed (', log)
        self.assertNotIn(str(self.tmp), log)
        self.assertNotIn('bloqueo', log)

    @unittest.skipIf(os.geteuid() == 0, 'root escribe en cualquier carpeta')
    def test_a_read_only_folder_is_a_500(self):
        self.dir.mkdir(mode=0o700)
        os.chmod(self.dir, 0o500)
        self.addCleanup(os.chmod, self.dir, 0o700)
        self.assertAnswer(self.post(EXAMPLE), 500, 'storage')
        self.assertEqual(self.err.getvalue(), '· feedback: storage failed (PermissionError)\n', 'esa línea y nada más')
        self.assertFalse(self.path.exists())

    def test_nothing_is_ever_written_inside_the_static_root(self):
        link = self.tmp / 'enlace'
        link.symlink_to(self.root, target_is_directory=True)
        for i, where in enumerate((self.root / 'feedback.jsonl', self.root / 'datos' / 'feedback.jsonl',
                                   link / 'feedback.jsonl')):
            with self.subTest(i=i), mock.patch.object(serve, 'FEEDBACK_PATH', str(where)):
                self.assertAnswer(self.post(EXAMPLE), 500, 'storage')
        self.assertEqual(os.listdir(self.root), [])
        self.assertIn('· feedback: storage failed (_FeedbackInsideRoot)', self.err.getvalue())
        old = self.root / 'feedback-2020-01-01.jsonl'
        old.write_bytes(b'x\n')
        with mock.patch.object(serve, 'FEEDBACK_PATH', str(self.root / 'feedback.jsonl')):
            serve._feedback_tidy()
        self.assertTrue(old.exists(), 'el hilo tampoco toca nada dentro de ROOT')

    def test_a_write_that_fails_halfway_leaves_no_half_line(self):
        self.assertAnswer(self.post(EXAMPLE), 200)
        before = self.path.read_bytes()
        real_write = os.write

        def half_then_full_disk(fd, data):
            real_write(fd, bytes(data[:len(data) // 2]))
            raise OSError(errno.ENOSPC, 'No space left on device')
        with mock.patch.object(serve.os, 'write', half_then_full_disk):
            self.assertAnswer(self.post(EXAMPLE), 500, 'storage')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.err.getvalue(), '· feedback: storage failed (OSError)\n', 'esa línea y nada más')


class Probe(FeedbackCase):
    def probe(self, body=PROBE_BODY, **headers):
        """Como server/proxy-probe.py --feedback: desde loopback, sin cabeceras de navegador."""
        sent = {'X-Feedback-Probe': '1'}
        sent.update(headers)
        return self.send(body, headers=sent, omit=tuple(h for h in BROWSER if h not in headers))

    def test_from_loopback_the_probe_checks_everything_and_writes_nothing(self):
        status, hdrs, body = self.probe()
        self.assertEqual((status, body), (204, b''))
        self.assertEqual(hdrs.get('x-feedback-probe'), 'ok')
        self.assertNotIn('content-length', hdrs)
        self.assertEqual(hdrs.get('x-content-type-options'), 'nosniff')
        self.assertEqual(hdrs.get('cache-control'), 'no-store')
        self.assertFalse(self.dir.exists(), 'ni la carpeta')
        # Las comprobaciones 1 a 10 corren igual en modo sonda.
        self.assertAnswer(self.probe(b'{}'), 400, 'schema')
        self.assertAnswer(self.probe(**{'Sec-Fetch-Site': 'cross-site'}), 403, 'cross-site')
        self.assertFalse(self.dir.exists())

    def test_behind_nginx_the_probe_header_is_ignored(self):
        self.assertAnswer(self.probe(**{'X-Forwarded-For': '192.0.2.9'}), 200)
        self.assertEqual(len(self.lines()), 1)

    def test_the_probe_fails_when_the_store_cannot_be_used(self):
        blocker = self.tmp / 'bloqueo'
        blocker.write_text('un fichero, no una carpeta', encoding='utf-8')
        for where in (blocker / 'feedback.jsonl', blocker / 'mas' / 'feedback.jsonl', self.root / 'feedback.jsonl'):
            with self.subTest(where=where.parent.name), mock.patch.object(serve, 'FEEDBACK_PATH', str(where)):
                self.assertAnswer(self.probe(), 500, 'storage')
        self.assertEqual(os.listdir(self.root), [])

    def test_a_folder_that_does_not_exist_yet_is_fine_if_it_can_be_created(self):
        with mock.patch.object(serve, 'FEEDBACK_PATH', str(self.tmp / 'nueva' / 'otra' / 'feedback.jsonl')):
            self.assertEqual(self.probe()[0], 204)
        self.assertFalse((self.tmp / 'nueva').exists())


class Units(unittest.TestCase):
    def test_the_safety_net_matches_the_shared_cases(self):
        for case in LEFTOVER_CASES:
            text = case['text'] if 'text' in case else ''.join(case['parts'])
            with self.subTest(text=text):
                self.assertEqual(serve._feedback_leftover(text), case['hit'])

    def test_the_numbers_of_the_spec(self):
        self.assertEqual((serve.FEEDBACK_MAX_BYTES, serve.FEEDBACK_MAX_MESSAGES, serve.FEEDBACK_MAX_TEXT),
                         (262_144, 400, 65_536))
        self.assertEqual((serve.FEEDBACK_RATE.window_s, serve.FEEDBACK_RATE.max_hits), (600, 10))
        self.assertEqual(serve.FEEDBACK_RATE.max_keys, 10_000)
        self.assertEqual(serve.FEEDBACK_GLOBAL_RATE.window_s, 3600)
        if 'ELFFUSS_FEEDBACK_GLOBAL_MAX' not in os.environ:
            self.assertEqual(serve.FEEDBACK_GLOBAL_RATE.max_hits, 200)
        if 'ELFFUSS_FEEDBACK_DAYS' not in os.environ:
            self.assertEqual(serve.FEEDBACK_KEEP_DAYS, 90)
            self.assertEqual(serve.FEEDBACK_DAY_MAX_BYTES, 2 << 20)
        self.assertEqual(serve.FEEDBACK_TOTAL_MAX_BYTES, 200 << 20)
        self.assertEqual((serve.FEEDBACK_READ_TIMEOUT_S, serve.FEEDBACK_RETRY_AFTER_S), (10, 600))
        self.assertEqual(serve.FEEDBACK_TIDY_EVERY_S, 6 * 3600)

    @staticmethod
    def load(**env):
        """serve.py cargado de nuevo con estas variables de entorno (y sin las de feedback de quien corre la prueba)."""
        clean = {k: v for k, v in os.environ.items() if k not in ('ELFFUSS_FEEDBACK', 'ELFFUSS_REPORTS',
                                                                  'ELFFUSS_FEEDBACK_DAYS')}
        clean.update(env)
        with mock.patch.dict(os.environ, clean, clear=True):
            spec = importlib.util.spec_from_file_location('elffuss_serve_env', SERVE_PY)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module

    def test_the_store_sits_next_to_reports_jsonl_unless_told_otherwise(self):
        def where(**env):
            return Path(self.load(**env).FEEDBACK_PATH)
        self.assertEqual(where(), Path.home() / 'elffuss' / 'feedback.jsonl')
        self.assertEqual(where(ELFFUSS_REPORTS=os.path.join('srv', 'datos', 'reports.jsonl')),
                         Path('srv', 'datos', 'feedback.jsonl'))
        self.assertEqual(where(ELFFUSS_REPORTS='srv/datos/reports.jsonl', ELFFUSS_FEEDBACK='otra/fb.jsonl'),
                         Path('otra', 'fb.jsonl'))

    def test_the_daily_cap_binds_before_the_total(self):
        # Los días que se guardan más el de hoy, todos llenos, caben en el total:
        # llenar un día solo cierra ese día, nunca los meses que tarda la poda.
        for days, kept in ((None, 90), ('90', 90), ('0', 0), ('30', 30), ('120', 120), ('365', 365), ('-3', 0)):
            with self.subTest(days=days):
                module = self.load(**({} if days is None else {'ELFFUSS_FEEDBACK_DAYS': days}))
                self.assertEqual(module.FEEDBACK_KEEP_DAYS, kept)
                self.assertLessEqual(module.FEEDBACK_DAY_MAX_BYTES * (module.FEEDBACK_KEEP_DAYS + 1),
                                     module.FEEDBACK_TOTAL_MAX_BYTES)
                self.assertLessEqual(module.FEEDBACK_DAY_MAX_BYTES, 2 << 20)

    def test_the_client_key_is_the_address_or_its_ipv6_56(self):
        key = serve._feedback_rate_key
        self.assertEqual(key('192.0.2.7'), '192.0.2.7')
        self.assertEqual(key('::ffff:192.0.2.7'), '192.0.2.7')
        self.assertEqual(key('2001:db8:1:2ff:abcd::9'), '2001:db8:1:200::/56')
        self.assertEqual(key('2001:db8:1:2ff::1'), key('2001:db8:1:200::1'))
        self.assertNotEqual(key('2001:db8:1:300::1'), key('2001:db8:1:200::1'))
        self.assertEqual(key('no-es-una-ip' * 20), ('no-es-una-ip' * 20)[:64])

    def test_the_limiter_can_look_without_spending(self):
        limiter = serve._FeedbackLimiter(60, 2)
        self.assertFalse(limiter.full('*'))
        self.assertFalse(limiter.full('*'), 'mirar no gasta')
        self.assertTrue(limiter.allow('*'))
        self.assertFalse(limiter.full('*'))
        self.assertTrue(limiter.allow('*'))
        self.assertTrue(limiter.full('*'))
        self.assertFalse(limiter.allow('*'))

    def test_the_table_of_clients_has_a_cap_and_frees_keys_that_expired(self):
        limiter = serve._FeedbackLimiter(0.4, 2, max_keys=2)
        self.assertEqual([limiter.take(k) for k in ('a', 'b', 'a', 'a', 'c', 'b')],
                         ['ok', 'ok', 'ok', 'limited', 'crowded', 'ok'])
        self.assertEqual(len(limiter._hits), 2, 'una clave que no entró no ocupa sitio')
        time.sleep(0.5)
        self.assertEqual(limiter.take('c'), 'ok', 'pasada la ventana, las claves viejas se van')
        self.assertEqual(sorted(limiter._hits), ['c'])

    def test_the_probe_mode_needs_loopback_and_no_forwarded_for(self):
        def probe(peer, **headers):
            message = http.client.HTTPMessage()
            for name, value in headers.items():
                message[name.replace('_', '-')] = value
            return serve._feedback_is_probe(types.SimpleNamespace(headers=message, client_address=(peer, 40000)))
        self.assertTrue(probe('127.0.0.1', X_Feedback_Probe='1'))
        self.assertTrue(probe('::1', X_Feedback_Probe='1'))
        self.assertFalse(probe('192.0.2.1', X_Feedback_Probe='1'))
        self.assertFalse(probe('127.0.0.1', X_Feedback_Probe='1', X_Forwarded_For='192.0.2.1'))
        self.assertFalse(probe('127.0.0.1', X_Feedback_Probe='1', X_Forwarded_For=''))
        self.assertFalse(probe('127.0.0.1', X_Feedback_Probe='yes'))
        self.assertFalse(probe('127.0.0.1'))

    def test_an_answer_to_someone_who_already_left_raises_nothing(self):
        # Si saltase, socketserver escribiría la traza en stderr, con su hora.
        class Gone:
            def __init__(self, fail_on):
                self.fail_on, self.close_connection, self.sent = fail_on, False, []
                self.wfile = types.SimpleNamespace(write=self.write)

            def send_response(self, status):
                self.sent.append(status)

            def send_header(self, name, value):
                pass

            def _proxy_safety_headers(self):
                pass

            def end_headers(self):
                if self.fail_on == 'headers':
                    raise BrokenPipeError(errno.EPIPE, 'Broken pipe')

            def write(self, data):
                raise ConnectionResetError(errno.ECONNRESET, 'Connection reset by peer')
        for fail_on in ('headers', 'body'):
            with self.subTest(fail_on=fail_on):
                h = Gone(fail_on)
                serve._feedback_answer(h, 200)
                self.assertEqual(h.sent, [200])
                self.assertTrue(h.close_connection)

    def test_a_connection_error_on_this_path_is_not_logged_and_elsewhere_it_is(self):
        def log_error(path):
            h = serve.Handler.__new__(serve.Handler)   # sin conexión: solo el método
            h.path = path
            err = io.StringIO()
            with mock.patch.object(serve.sys, 'stderr', err):
                h.log_error('Request timed out: %r', TimeoutError('timed out'))
            return err.getvalue()
        self.assertEqual(log_error('/proxy/feedback'), '')
        self.assertEqual(log_error('/proxy/report'), "· Request timed out: TimeoutError('timed out')\n")

    def test_reading_the_body_has_a_total_deadline(self):
        class Drip:   # un byte cada 0,2 s, para siempre: ningún timeout por lectura salta
            def read1(self, n):
                time.sleep(0.2)
                return b'x'
        fake = types.SimpleNamespace(rfile=Drip(), connection=types.SimpleNamespace(settimeout=lambda t: None))
        with mock.patch.object(serve, 'FEEDBACK_READ_TIMEOUT_S', 1):
            started = time.monotonic()
            self.assertIsNone(serve._feedback_read(fake, 1000))
        self.assertLess(time.monotonic() - started, 5)

    def test_main_starts_the_janitor_thread(self):
        seen = []
        ran = threading.Event()

        def janitor():
            seen.append(threading.current_thread())
            ran.set()

        class FakeServer:
            allow_reuse_address = False

            def __init__(self, address, handler):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def serve_forever(self):
                pass
        with mock.patch.object(serve.socketserver, 'ThreadingTCPServer', FakeServer), \
                mock.patch.object(serve, '_feedback_janitor', janitor), mock.patch('builtins.print'):
            serve.main(['serve.py', '8642'])
            self.assertTrue(ran.wait(5))
        self.assertEqual(seen[0].name, 'feedback-janitor')
        self.assertTrue(seen[0].daemon)

    def test_the_janitor_logs_a_failure_and_keeps_going(self):
        class Stop(Exception):
            pass
        calls = []

        def failing_tidy():
            calls.append(1)
            raise PermissionError(13, 'Permission denied', 'ruta-que-no-se-escribe')

        def sleep(seconds):
            self.assertEqual(seconds, 6 * 3600)
            if len(calls) >= 2:
                raise Stop()
        err = io.StringIO()
        with mock.patch.object(serve, '_feedback_tidy', failing_tidy), mock.patch.object(serve.time, 'sleep', sleep), \
                mock.patch.object(serve.sys, 'stderr', err):
            with self.assertRaises(Stop):
                serve._feedback_janitor()
        self.assertEqual(err.getvalue(), '· feedback: tidy failed (PermissionError)\n' * 2)


if __name__ == '__main__':
    unittest.main()
