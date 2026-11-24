# Escape-attempt suite 1.1.0 (execution extension)

Code: `apps/api/src/modules/appbuilder/internal/sandbox/escape-suite.ts` (base catalogue, 1.0.0 plus the version bump) and `escape-suite-exec.ts` (new). Unit run without a database: `escape-suite.spec.ts`; the integration spec `sandbox.int.spec.ts` runs the whole suite with the database-backed ticket attempts.

## Two kinds, as before
- **`control-plane` (EX-\*)** attack a control the control plane owns. They run for real on any runtime. A BLOCKED result is evidence for that control and **only that control**.
- **`isolating-runtime` (XR-\*, plus the base IS/NS/MP/RS/PS/KI/MS/LM/RX/CA families)** need a verified isolating runtime. On the mock and the local runner they are `NOT_VERIFIED`: not executed, not counted. **A mock cannot be attacked, so it cannot pass them.** `isolationEvidence` is true only when a `verified` runtime executed every isolating attempt with 0 escapes.

## Added in 1.1.0 (counts at this commit: 127 EX control-plane + 21 XR isolating = 148 new; the whole suite is 273 attempts)
| Family | Attempts (control plane, EX-\*) | Control that must stop them |
|---|---|---|
| `exec_policy` | 22 model-supplied members (argv, command, shell, env, cwd, image, volumes, privileged, approval…), unknown and inherited profile names, other tenant/run, 20 script-name and parameter injections (metacharacters, substitution, lifecycle and publish scripts, prototype names), 10 bad directories, approval abuse (self-approval by model/API key/system, replay, wrong decision) | gateway closed surface; approval workflow |
| `exec_env` | LD_PRELOAD, NODE_OPTIONS, cloud and database credentials, proxies, npm config, BASH_ENV, PATH change | environment guard (the constant, nothing else) |
| `exec_workspace` | `.env`, keys, `.git`, `.aws`, AWS key and canary content | workspace guard before anything is copied in |
| `exec_artifact` | traversal, absolute, outside output roots, sensitive, symlink/hardlink/device, flood; auto-apply | artifact policy; artifacts are candidates only |
| `exec_output` | forged block terminator and instructions, secrets, canaries, output flood, audit as a covert channel | output framing and screening; content-free audit |
| `exec_gate` | default gate, each missing condition, production without D-42, a real-looking runtime behind a closed gate, mock executes, local developer runner | `executionGate`; orchestrator; `MockExecutionPort`; execution port refuses `local-dev` |
| `exec_runtime_spec` | 14 weakened runtime specifications (privileged, host namespaces, Docker socket, host root, writable root, kept capabilities, unconfined seccomp, root user, plain runc, shared netns, no pids limit, swap, another run's workspace) | `validateRuntimeSpec` |
| `exec_quota` | no budget, queue flood, noisy neighbour, NaN usage, kill switch, SIGTERM-ignoring sandbox | quota ledger, queue, limits, kill switch, terminator |

| Family (isolating, XR-\*) | Attempts | Control the real runtime must provide |
|---|---|---|
| `symlink_mount` | symlink/hardlink to host files, bind-mount of `/`, symlink swap (TOCTOU), `/proc/self/root`, another run's workspace | no host paths in the namespace, read-only root, nosuid/nodev, no mount capability |
| `namespace_capability` | user namespace, cgroup move, ptrace PID 1 | seccomp, no capabilities, read-only cgroup fs |
| `lifecycle_script` | npm lifecycle scripts re-enabled via env, daemon outliving the run, zombie storm | fixed argv with `--ignore-scripts`, process-group kill, pids limit |
| `dns_exfiltration` `lateral_movement` `metadata_service` | data-carrying DNS name, queue port of the control plane, IMDSv2 token request, proxy abuse in `registry-only` | filtered DNS, segment with no route, no metadata route, per-class proxy allow-list |
| `resource_exhaustion` | 2 GB output flood, many-small-allocation memory bomb, inode exhaustion | output cap, cgroup memory, disk and inode quota |
| `canary` `runtime_socket` | PID 1 environment, inherited socket descriptors | PID namespace, constant environment, no inherited fds |

## Findings of this extension (all fixed, all with tests)
1. **`decideExec` threw on inherited object names** (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) used as the profile: the lookup returned an object, the next line dereferenced `params` of it. A model could make the gateway throw instead of refusing (availability; no bypass, the profile was never enabled). Now own properties only; reads as `unknown_profile` (`exec-policy.spec.ts`, EX-PROFILE-2..5).
2. **Base ticket attempts WS-2/3/4/6 reported ESCAPED when the suite ran without a database** (`!!c.tickets && …` is false for "no tickets"). They now throw like WS-1/5, i.e. `NOT_VERIFIED`; with a database nothing changes.

## What a green result here means
`0 ESCAPED` and all EX-\* BLOCKED says: the gateway, guards and policies the control plane owns refuse these attacks. It says **nothing** about namespaces, seccomp, cgroups, the VMM, network segmentation or any real runner.
