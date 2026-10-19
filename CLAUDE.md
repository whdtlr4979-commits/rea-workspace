# TradingView

## REA (Reverse Engineer Anything)

이 저장소는 [morluto/rea](https://github.com/morluto/rea)의 MCP 서버와 스킬을 프로젝트 단위로 사용합니다.

- `.mcp.json` — `rea` MCP 서버 등록 (`npx -y rea-agents@6.7.0 mcp`, 버전 고정)
- `.claude/settings.json` — `rea` 서버 자동 승인 (`enabledMcpjsonServers`)
- `.claude/skills/reverse-engineer-anything/` — rea-agents 6.7.0 번들 스킬 (MIT, `LICENSE` 포함)

REA는 바이너리·패키지·Electron/JS 앱·웹사이트 등 소스가 없는 대상을 분석할 때만 사용합니다. 이 저장소 자체의 소스 분석에는 일반 도구를 사용합니다.

정적 JavaScript/Electron 분석은 추가 엔진 없이 동작합니다. 네이티브 바이너리 분석은 Ghidra를 사용합니다.

- `scripts/install-ghidra.sh` — Ghidra 12.1.4를 `/opt`에 설치하고 `ghidraRun`을 PATH에 연결 (REA는 Ghidra 12.1.x만 지원, JDK 21 필요). 클라우드 환경의 setup script에서 실행됩니다.
- 준비 상태 확인: `npx -y rea-agents@6.7.0 doctor --provider ghidra --json`

### 버전 업데이트

`.mcp.json`의 버전과 스킬을 함께 올립니다:

```bash
npm pack rea-agents@<버전>
tar xzf rea-agents-<버전>.tgz
rm -rf .claude/skills/reverse-engineer-anything
cp -r package/skills/reverse-engineer-anything .claude/skills/
cp package/LICENSE .claude/skills/reverse-engineer-anything/
```
