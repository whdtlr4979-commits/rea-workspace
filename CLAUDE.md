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

## 차트 앱 (`app/`)

`specs/charting.md`를 바탕으로 만든 Canvas 2D 차트 엔진 MVP입니다(TypeScript + Vite, 프레임워크 없음). 시세는 앱 안의 가짜 데이터 서버(`app/src/server/`)가 만들고, 지표 계산도 이 서버에서 합니다. 클라이언트는 명세의 프로토콜(`~m~` 프레이밍, `{m,p}` 메시지, turnaround)로 데이터를 받아 그리기만 합니다.

```bash
cd app
npm install
npm test           # 단위 + 프로토콜 통합 테스트
npm run typecheck
npm run dev        # http://127.0.0.1:5173
```

구조와 지원 기능은 `app/README.md`에 있습니다.
