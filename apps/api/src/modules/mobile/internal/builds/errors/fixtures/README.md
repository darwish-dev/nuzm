# Build-error fixtures (P3-S06)

Each `*.log` is raw tool output used to test the parsers in `../`.

| prefix        | origin                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-*` | hand-written from the documented message formats of the Dart analyzer/compiler, `flutter test`, pub, Gradle/AGP/Kotlin, Xcode/CocoaPods. **SIMULATED**: they prove the parser handles that format, not that a real tool printed it.                      |
| `captured-*`  | output a real tool printed on this Mac for a deliberately broken copy of the Nuzm Flutter _template_ (no AI-generated code, no network beyond pub.dev). Header comment names the command, tool versions and date. **LIVE-VERIFIED** for the format only. |

Xcode fixtures are all `synthetic-*`: no full Xcode exists on the owner's Mac (B-iOS). The first real iOS run must add `captured-xcode-*` and fix the parser where it misses.
Absolute paths in fixtures use `/work/build/` as the project root.
