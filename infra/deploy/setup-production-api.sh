#!/usr/bin/env bash
# Run as root on the VPS, after deploying the production API code.
# Creates a dedicated PostgreSQL cluster; never alters an existing project's roles or databases.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root'; exit 1; }
command -v pg_createcluster >/dev/null || { echo 'Install PostgreSQL 16 (postgresql-16) first'; exit 1; }
ROOT=/srv/nuzm/current
[ -s "$ROOT/apps/api/dist/main.js" ] || { echo 'Deploy the API entrypoint first'; exit 1; }
if ! pg_lsclusters --no-header | awk '$1 == "16" && $2 == "nuzm" {found=1} END {exit !found}'; then
  pg_createcluster 16 nuzm --port 55440 --start
fi
pg_ctlcluster 16 nuzm start || pg_ctlcluster 16 nuzm status
install -d -m 750 -o root -g deploy /etc/nuzm
install -d -m 700 -o deploy -g deploy /var/lib/nuzm/secrets

python3 - <<'PY'
import base64, grp, json, os, pathlib, secrets, shlex, subprocess

base = pathlib.Path('/etc/nuzm')
api = base / 'api.env'
migrate = base / 'migrate.env'
worker = base / 'worker.env'
keyfile = base / 'secret-store.key'
paths = [api, migrate, worker, keyfile]
present = [p.exists() for p in paths]
if any(present):
    if not all(present):
        raise SystemExit('Partial API configuration exists; refusing to replace keys. Restore or review /etc/nuzm before continuing.')
    print('Keeping existing API configuration and keys.')
else:
    gid = grp.getgrnam('deploy').gr_gid
    def persist(path, content):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        os.chown(path, 0, gid)
    def key():
        return base64.b64encode(secrets.token_bytes(32)).decode()
    def env(values):
        return ''.join(k + '=' + shlex.quote(v) + '\n' for k,v in values.items())
    admin_pw, app_pw, worker_pw = [secrets.token_hex(32) for _ in range(3)]
    # This role lives only in the dedicated cluster. Random hex values cannot inject SQL.
    sql = "CREATE ROLE nuzm_migrator LOGIN SUPERUSER PASSWORD '" + admin_pw + "';\n"
    subprocess.run(['runuser','-u','postgres','--','psql','-p','55440','-v','ON_ERROR_STOP=1'], input=sql, text=True, check=True, stdout=subprocess.DEVNULL)
    checkpoint = key()
    persist(keyfile, key() + '\n')
    persist(api, env({
        'NODE_ENV':'production', 'PORT':'4000',
        'DATABASE_URL':f'postgres://nuzm_app:{app_pw}@127.0.0.1:55440/nuzm_production',
        'SESSION_SEAL_KEY':key(), 'AUDIT_HASH_KEY':key(), 'AUDIT_CHECKPOINT_KEY':checkpoint,
        'AUTH_OIDC_ENABLED':'false',
        'SECRET_STORE_DIR':'/var/lib/nuzm/secrets', 'SECRET_STORE_KEY_FILE':str(keyfile),
        'RETURN_TO_ORIGINS':'https://nuzm.dev,https://www.nuzm.dev,https://admin.nuzm.dev',
        'DEFAULT_RETURN_TO':'/console', 'PUBLIC_API_URL':'https://nuzm.dev',
        'FIELD_ENCRYPTION_KEYS':json.dumps([{'id':'production1','ref':'vault://production/field-key-production1','current':True}]),
    }))
    persist(migrate, env({'DATABASE_ADMIN_URL':f'postgres://nuzm_migrator:{admin_pw}@127.0.0.1:55440/nuzm_production'}))
    persist(worker, env({'NODE_ENV':'production','WORKER_DATABASE_URL':f'postgres://nuzm_worker:{worker_pw}@127.0.0.1:55440/nuzm_production','AUDIT_CHECKPOINT_KEY':checkpoint}))
    # Role passwords are applied after migrations create the runtime roles below.
print('Configuration ready; no secret values printed.')
PY

cd "$ROOT"
runuser -u deploy -- bash -c 'set -a; . /etc/nuzm/migrate.env; set +a; cd /srv/nuzm/current; pnpm db:migrate'
python3 - <<'PY'
import pathlib, shlex, subprocess, urllib.parse
sql = ''
for name, variable, role in [('api.env','DATABASE_URL','nuzm_app'),('worker.env','WORKER_DATABASE_URL','nuzm_worker')]:
    values = dict(line.split('=',1) for line in pathlib.Path('/etc/nuzm',name).read_text().splitlines() if '=' in line)
    password = urllib.parse.urlparse(shlex.split(values[variable])[0]).password
    if not password or not all(c in '0123456789abcdef' for c in password):
        raise SystemExit('Unexpected password format; refusing role changes')
    sql += f"ALTER ROLE {role} LOGIN PASSWORD '{password}';\n"
subprocess.run(['runuser','-u','postgres','--','psql','-p','55440','-v','ON_ERROR_STOP=1'],input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
PY

runuser -u deploy -- bash -c 'set -a; . /etc/nuzm/api.env; set +a; cd /srv/nuzm/current; node -' <<'JS'
const { randomBytes } = require('node:crypto');
const { configuredSecretStore, SecretNotFoundError } = require('./apps/api/dist/common/secrets');
(async () => {
  const store = configuredSecretStore();
  try { await store.get('vault://production/field-key-production1'); }
  catch (e) {
    if (!(e instanceof SecretNotFoundError)) throw e;
    await store.create('field-key-production1', randomBytes(32).toString('base64'));
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
JS

systemctl restart nuzm-api
for attempt in $(seq 1 30); do
  if curl --noproxy '*' -fsS http://127.0.0.1:4000/healthz; then
    echo; echo 'API is running. Back up /etc/nuzm and /var/lib/nuzm/secrets securely together; neither key nor ciphertext may be lost.'
    exit 0
  fi
  sleep 2
done
echo 'API startup failed; inspect journalctl -u nuzm-api (do not share credentials).'
exit 1
