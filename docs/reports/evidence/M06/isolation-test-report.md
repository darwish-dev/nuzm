# M06 isolation / escape test report (MOCK node — NOT VERIFIED on a real node)

Source: `apps/api/src/modules/hosting/internal/mock/isolation.spec.ts` (30 cases) and `internal/agent/agent.spec.ts` (envelope/allow-list/injection cases). Every attempt is made AS site A against site B's assets on the **simulated** node (`MockCloudPanelNode`: Linux users/groups, file modes, symlinks, private /tmp, hidepid /proc, per-site PHP-FPM settings, per-site DB users, quotas, SFTP chroot, encrypted per-site backups).

**What this proves:** the hardening contract the node agent must apply (and that the control plane asks for) is complete and internally consistent; the agent contract rejects forged/expired/replayed/foreign/injected commands.
**What it does not prove:** anything about a real kernel, filesystem, PHP-FPM, MySQL or CloudPanel. AC-M06-04 stays **BLOCKED (HG-06-01)** for the live rows; the mock result is labelled NOT VERIFIED (CLAUDE.md §5, §6).

| # | Attempt (as site A) | Expected | Result |
|---|---|---|---|
| 01 | read B `.env` by absolute path | EACCES | denied |
| 02 | read B world-readable file inside B's 0700 home | EACCES | denied |
| 03 | `../` traversal from A's home into B's | EACCES | denied |
| 04 | symlink in A's htdocs → B's file | EACCES | denied |
| 05 | symlink to B's home directory | EACCES | denied |
| 06 | list B's home | EACCES | denied |
| 07 | read B's /tmp (private per-site tmp) | ENOENT/EACCES | denied |
| 08 | read /etc/shadow, agent private state | EACCES | denied |
| 09 | symlink loop / 12-deep chain | ENOENT | denied |
| 10 | write into B's home | EACCES | denied |
| 11 | SFTP chroot escape (`../`, absolute symlink) | denied/ENOENT | denied |
| 12 | `/proc` listing of B's processes (hidepid=2) | invisible | invisible |
| 13 | `/proc/<pid>/environ` of B | EACCES | denied |
| 14 | connect to B's PHP-FPM socket | EACCES | denied |
| 15 | read B's crontab | EACCES | denied |
| 16 | read B's logs | EACCES | denied |
| 17 | read B's TLS private key | EACCES | denied |
| 18 | control: A reads its own logs | allowed | allowed |
| 19 | PHP `open_basedir`: include B's file | OPEN_BASEDIR | denied |
| 20 | `open_basedir` bypass via symlink | denied | denied |
| 21 | `open_basedir` bypass via `../` | denied | denied |
| 22 | dangerous PHP functions (exec, system, proc_open, popen, shell_exec, passthru, putenv, symlink, case variants) | disabled | disabled |
| 23 | cross-user SQL against B's database | DB_DENIED | denied |
| 24 | `information_schema` / `SHOW DATABASES` enumeration | only A's DB | only A's DB |
| 25 | `USE B`, GRANT, CREATE USER, DROP DATABASE | DB_DENIED | denied |
| 26 | fork bomb | stops at the process limit; neighbour unaffected | confined |
| 27 | disk fill | EDQUOT; neighbour can still write | confined |
| 28 | inode fill | EDQUOT; neighbour can still create | confined |
| 29 | command-argument trick (`"A B"` as a site name) | rejected by the agent schema | rejected |
| 30 | backup archives: per-site key, ciphertext only; keys differ | no plaintext, keys distinct | holds |

Agent channel (`agent.spec.ts`, 25 tests): unsigned, forged, unknown key id, tampered argument, tampered command id, wrong node (lateral movement), expired, not-yet-valid, over-long TTL, replayed nonce, replay after agent restart, oversize, non-object, missing body = **14 envelope cases, 100 % rejected**; 9 non-allow-listed command names (incl. `__proto__`, `constructor`, case variants) rejected; 13 injection payloads in `site` rejected; 10 malformed `site.create` argument sets rejected; token reuse with different arguments rejected; the hash-chained audit log records every decision and detects tampering.

**Not simulated (stays NOT VERIFIED / BLOCKED):** neighbour latency degradation (< 20 % proposal) under a noisy neighbour, kernel namespace/cgroup behaviour, real PHP-FPM pool config, MySQL privilege model, mTLS, signed self-update, node-to-node network policy, CloudPanel's own privilege-escalation history (changelog 2.3–2.5) — see the threat model §8.
