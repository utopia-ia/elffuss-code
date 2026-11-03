// La config de la memoria compartida en Code: copia byte a byte de la de Claw,
// y sync-memoria.sh (lo que llama deploy.sh) lo hace cumplir.
//
//   node tests/memoria-v2-config.mjs        (CLAW=<checkout de Claw> opcional)
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buscarClaw } from './memoria-v2-servidor.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let fallos = 0;
const ok = (n, c, e = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (e ? '  — ' + e : '')); if (!c) fallos++; };

const { default: cfg } = await import('../web/memory/memory.config.js');
const code = cfg.apps.find((a) => a.id === 'code');
ok('Code está en la config con su origen exacto', code?.origin === 'https://code.elffuss.com');
ok('Code puede guardar hechos de un proyecto', cfg.features.projectScope.includes('code'));
ok('la página almacén es https', new URL(cfg.storeUrl).protocol === 'https:');
ok('la config solo importa el motor', [...readFileSync(join(RAIZ, 'web/memory/memory.config.js'), 'utf8').matchAll(/from '([^']+)'/g)].every((m) => m[1] === '../js/engine/memory-config.js'));

// sync-memoria.sh --revisa: verde con la de Claw, rojo con otra y sin Claw.
const revisa = (claw) => { try { execFileSync(join(RAIZ, 'sync-memoria.sh'), [claw, '--revisa'], { stdio: 'ignore' }); return 0; } catch (e) { return e.status ?? 1; } };
const falsa = mkdtempSync(join(tmpdir(), 'claw-falsa-'));
mkdirSync(join(falsa, 'web', 'memory'), { recursive: true });
writeFileSync(join(falsa, 'web', 'memory', 'memory.config.js'), readFileSync(join(RAIZ, 'web/memory/memory.config.js'), 'utf8').replace("namespace: 'elffuss-memory'", "namespace: 'otra-memoria'"));
ok('sync-memoria.sh --revisa falla si la de Claw es otra', revisa(falsa) === 1);
ok('…y si no encuentra la de Claw', revisa(join(falsa, 'no-existe')) === 1);
rmSync(falsa, { recursive: true, force: true });
const claw = buscarClaw();
if (claw) ok(`la copia de Code es la de Claw byte a byte (${claw.split('/').pop()})`, revisa(claw) === 0);
else console.log('   (sin checkout de Claw con la memoria al lado: no se compara con él; CLAW=<ruta>)');

console.log(fallos ? `\n❌ ${fallos} fallos` : '\n✅ todo bien');
process.exit(fallos ? 1 : 0);
