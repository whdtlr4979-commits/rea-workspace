# TradingView 웹 차트 기능 명세 (역분석)

> 대상: `https://www.tradingview.com/chart/` (비로그인 익명 세션)
> 분석일: 2026-10-19 · 서버 릴리스 `release_210-16` · 빌드 `BUILD_TIME=2026-10-19T12:12:13`
> 목적: 차트 동작·지표 계산·데이터 흐름·UI 구조를 재구현 가능한 수준의 기능 명세로 정리

## 0. 분석 방법과 근거 표기

| 표기 | 의미 |
|---|---|
| **[관찰]** | 헤드리스 Chromium으로 실제 페이지를 띄워 WebSocket 프레임·네트워크·접근성 트리·스크린샷을 캡처해 확인한 사실 |
| **[정적]** | 배포된 JS 번들을 실행하지 않고 읽어서 확인한 사실 (함수 본문·상수·enum) |
| **[추론]** | 위 두 근거를 바탕으로 한 해석. 직접 확인하지 않음 |

- 정적 분석 범위: 차트 페이지 HTML이 참조하는 초기 번들 56개 + 인라인 스크립트 + 차트 관련 지연 로드 청크 52개 (총 109개 파일, 약 6.2MB). REA `analyze_javascript_application`으로 모듈 그래프(4,526개 모듈)를 만들고, 나머지는 직접 읽었다. `14041.*.js`는 분석기 힙 한도로 의미 분석이 빠졌다.
- 런타임 관찰 범위: 익명 사용자로 차트 로드, 하단 `5D` 버튼으로 타임프레임 변경, 지표 대화상자 열기와 검색. 지표 추가는 익명 사용자에게 가입 유도 모달(regwall)이 떠서 막혔다(→ §8.6).
- 로그인 세션 HAR(Chrome sanitized 내보내기, 2026-10-19 13:32 UTC): 저장된 레이아웃 `/chart/<id>/`을 다시 연 시점부터 약 2분 구간이다. WebSocket 메시지 351개와 HTTP 요청 782개가 들어 있다. 이 구간에서 레이아웃 불러오기, 드로잉 불러오기, pointset, 장중 실시간 틱을 확인했다(아래 **[관찰-HAR]**). HAR 원본에는 인증 토큰이 남아 있어 저장소에 넣지 않았다.
- 모듈 이름은 번들 안의 로거 이름(`getLogger("Chart.TimeScale")` 등)과 webpack 청크 이름을 기준으로 적었다. 숫자 청크 해시는 배포마다 바뀐다.

---

## 1. 시스템 개요

```
┌──────────────────────────── 브라우저 (www.tradingview.com/chart/) ───────────────────────────┐
│                                                                                              │
│  UI 셸 (React/DOM)                       차트 엔진 (Canvas 2D)                               │
│  ├ 상단 헤더 툴바                         ChartWidgetCollection ─ ChartWidget ×N (레이아웃)   │
│  ├ 좌측 드로잉 툴바                         └ ChartModel                                      │
│  ├ 하단 타임프레임/시간대 바                    ├ TimeScale (공유 X축, bar index 기반)        │
│  ├ 우측 위젯바 (Watchlist 등)                   ├ Pane ×N ─ PriceScale ×N ─ Sources           │
│  └ 대화상자/플로팅 툴바 (지연 로드 청크)        │     (Series, Study, LineTool, Crosshair…)    │
│                                                 └ UndoModel / Selection / Crosshair           │
│                │                                   ▲ data_update / timescale_update            │
│                ▼                                   │                                            │
│  ChartApi (TVChartApi) ── ChartSession / QuoteSession / (Replay, Depth)                        │
│                │  JSON {m,p}                                                                    │
│  WSBackendConnection ── socket.io 스타일 프레이밍 ~m~len~m~ ── wss://data.tradingview.com      │
└────────────────┼─────────────────────────────────────────────────────────────────────────────┘
                 │
     ┌───────────┴───────────┬──────────────────────┬─────────────────────────┐
     ▼                       ▼                      ▼                         ▼
 data / prodata           pine-facade          www.tradingview.com      charts-storage
 (시세·바·지표 계산)      (Pine 컴파일·목록)    /api/v1/* (레이아웃 저장)  (드로잉 저장, JWT)
```

핵심 설계 원칙:

1. **계산은 서버, 렌더링은 클라이언트.** 바 집계(타임프레임 리샘플링, Renko/Kagi/P&F/Heikin Ashi 등)와 모든 지표(내장 지표·Pine 스크립트)는 서버 세션에서 계산된다. 클라이언트는 결과 plot 값을 받아 캔버스에 그린다. [정적][관찰]
2. **bar index 좌표계.** 서버가 시간축을 정수 index 기준으로 관리하고(`timescale_update`), 시리즈와 지표 값은 모두 `{i: index, v: [...]}` 형태로 온다. 클라이언트 X축도 index 기반이다. [관찰]
3. **turnaround 토큰.** 심볼·인터벌이 바뀔 때마다 세대 토큰(`s1`, `s2`, …)이 올라가고, 이전 세대의 늦게 도착한 응답은 버려진다. [정적][관찰]

---

## 2. 페이지 부트스트랩과 번들 구조

### 2.1 로딩 순서 [정적][관찰]

1. HTML 응답 직후의 DOM에는 로딩 스피너(`tv-space-loader`)와 aria-live 영역만 있고, 나머지 UI는 전부 JS가 만든다.
2. 인라인 스크립트가 `window.WSBackendConnection`을 즉시 만들어 WebSocket 연결을 시작한다. 번들 로드보다 먼저 연결해 지연을 줄이려는 것으로 보인다. [추론]
3. webpack 런타임(`runtime.*.js`)이 청크 맵을 가진다. 이름 있는 청크 1,035개를 포함해 해시 맵 항목이 1,638개다. 다국어 문자열은 `__LANG__.<id>.<hash>.js` 패턴으로 언어별로 따로 로드한다.
4. 진입 번들은 `main_chart.*.js`와 `chart-renderer.*.js`이고, 기능 단위 UI는 이름 있는 청크로 지연 로드한다(예: `header-toolbar`, `drawing-toolbar`, `chart-widget-gui`, `floating-toolbars`, `study-search-dialog`, `line-tool-*`).
5. 런타임 관찰 결과 초기 로드에서 정적 스크립트 352개와 스타일시트 308개를 요청했다. [관찰]

### 2.2 주요 모듈 위치 [정적]

| 영역 | 로거/모듈 이름 | 소재 |
|---|---|---|
| 차트 모델 | `Chart.ChartModel`, `Chart.Pane`, `Chart.TimeScale`, `Chart.Series`, `Chart.Crosshair`, `Chart.ChartUndoModel`, `Chart.ChartWidgetCollection` | 코어 번들(약 1.35MB) |
| 시리즈 데이터 | `Chart.SeriesDataSource`, `Chart.PlotList` | 별도 번들 |
| 지표 | `Chart.Study`, `Chart.StudyDataSource`, `Chart.Study.MetaInfo`, `Chart.Studies.StudyMetaInfoRepository`, `Chart.StudyMigration` | 여러 번들에 분산 |
| 서버 API | `ChartApi.Core`, `ChartApi.ChartSession`, `ChartApi.QuoteSession`, `ChartApi.TrafficMeter` | `TVChartApi` 모듈 |
| 전송 계층 | `WSBackendConnection`(인라인), `PersistentWebsocketTransport`, `NativePushStreamTransport` | 인라인 + 공용 번들 |
| 저장 | `ChartStorage`(드로잉), `backend.saveChart`/`loadLayout`(레이아웃) | 코어 + 공용 번들 |
| 워커 | `async-gzip.worker`(레이아웃 압축), `timer.worker`(백그라운드 탭 타이머) | 지연 청크 |

---

## 3. UI 구조

### 3.1 화면 레이아웃 [관찰: 1600×900 스크린샷 + 접근성 트리]

```
┌─────────────────────────────── 상단 헤더 툴바 ───────────────────────────────────────┐
│ ☰ │ AAPL │ ⊕비교 │ D(인터벌) │ 캔들(스타일) │ Indicators │ 템플릿 │ Alert │ Replay │ ↶ ↷ │
│                    레이아웃 설정 │ Save ▾ │ 빠른검색 │ 설정 │ 전체화면 │ 스냅샷 │ Trade │ Upgrade│
├──┬───────────────────────────────────────────────────────────────┬──────────────┬──┤
│좌│ 범례: 심볼명 · 인터벌 · 거래소 | O H L C 변동 | Sell/Buy 버튼    │ Watchlist    │우│
│측│ 지표 범례 행(Vol …) [숨김][설정][삭제][더보기]                   │  섹션별 심볼  │측│
│드│                                                                 │  (Indices,   │위│
│로│                 메인 Pane (캔들 + 거래량 오버레이)       가격축 │  Stocks, …)  │젯│
│잉│                                                                 ├──────────────┤바│
│툴│                                                                 │ 심볼 상세     │아│
│바│                                                         시간축  │ (가격·통계·  │이│
│  ├─────────────────────────────────────────────────────────────────┤  재무·뉴스)  │콘│
│  │ 1D 5D 1M 3M 6M YTD 1Y 5Y All │ Go to │ 12:24:54 UTC │ RTH │ ADJ │              │  │
└──┴─────────────────────────────────────────────────────────────────┴──────────────┴──┘
```

### 3.2 영역별 구성 요소

**상단 헤더 툴바** [관찰]
- 심볼 검색(`AAPL`), 데이터 유형 전환, 심볼 비교(Compare)
- 인터벌 선택(`D`, `5m` …), 차트 스타일 선택(`Candles` …)
- `Indicators, metrics, and strategies` 대화상자, 지표 템플릿
- 알림 생성(Alert), 바 리플레이(Replay), 실행 취소/다시 실행(초기에는 비활성)
- 레이아웃 설정(멀티 차트), 저장(Save) + 레이아웃 관리, 빠른 검색, 설정, 전체화면, 스냅샷, 아이디어 공유, Trade, Upgrade

**좌측 드로잉 툴바** [관찰] — 버튼과 그룹 메뉴가 짝을 이룬다.
- 커서 종류 / 추세선 + 추세 도구 / 피보나치 되돌림 + Gann·Fib 도구 / XABCD + 패턴 / 롱 포지션 + 예측·측정 도구 / 브러시 + 도형 / 텍스트 + 주석 / 아이콘
- 측정(Measure), 확대(Zoom in)
- 마그넷 모드 + 옵션, 계속 그리기(Keep drawing), 드로잉·지표 잠금, 전체 숨기기, 객체 삭제

**차트 영역** (`region "Chart #1"`) [관찰]
- 상단 범례: 심볼 설명 · 인터벌 · 거래소, 플래그, 시장 상태(예: "Pre-market · One update every 5 seconds"), OHLC와 변동률
- 매수/매도 호가 버튼(Sell/Buy, 스프레드 표시)
- 지표 범례 행(예: `Vol`), 행마다 숨김·설정·삭제·더보기 버튼, 범례 접기 버튼

**하단 툴바** [관찰]
- 타임프레임 프리셋. 범위와 인터벌이 함께 바뀐다.

| 버튼 | 범위 | 인터벌 |
|---|---|---|
| 1D | 1일 | 1분 |
| 5D | 5일 | 5분 |
| 1M | 1개월 | 30분 |
| 3M | 3개월 | 1시간 |
| 6M | 6개월 | 2시간 |
| YTD | 연초 이후 | 1일 |
| 1Y | 1년 | 1일 |
| 5Y | 5년 | 1주 |
| All | 전체 | 1개월 |

- 특정 날짜로 이동(Go to), 시간대 선택(현재 시각 표시), 세션 전환(`RTH`/연장 세션, 장중 인터벌일 때만 표시), 배당 조정(`ADJ`)

**우측 위젯바** [관찰]
- 아이콘 바: Watchlist·상세·뉴스 / Alerts / Object tree·Data window / AI Copilot / Screeners / Pine Editor / Calendars / Community / Notifications / Chats / Products / Help Center
- Watchlist 패널: 섹션(Indices, Stocks, Futures, Forex, Crypto), 열(Symbol, Last, Chg, Chg%)
- 심볼 상세 패널: 현재가, 장전/장후 가격, 거래량, Key facts, 재무, 실적, 배당, 시즌성, 기술적 등급, 애널리스트 의견, 옵션 IV 등

**하단 위젯바** [정적: 청크 이름] — Pine Editor(`pine-editor-bottom`), 전략 테스터(`backtesting-*`), Pine 타일(`bottom-pine-tiles`), 리플레이 트레이딩(`bottom-replay-trading-widget`) 등

**지연 로드 대화상자와 플로팅 UI** [정적: 청크 이름]
- 지표 검색(`study-search-dialog`): 탭은 Indicators / Strategies / Profiles / Patterns / Options [관찰]. 사이드바는 Personal(My scripts, Purchased), Built-in(Technicals, Fundamentals), Community(Editors' picks, Top, Trending, Marketplace) [관찰]
- 차트 속성(`general-chart-properties-dialog`), 지표 속성(`study-property-pages-with-definitions`), 지표 템플릿(`study-template-dialog`)
- 드로잉 플로팅 툴바(`floating-toolbars`), 객체 트리(`object-tree-panel`), 컨텍스트 메뉴(`context-menu-renderer`)
- 차트 내보내기(`chart-export-dialog`), 스냅샷(`take-chart-image-impl`), 레이아웃 불러오기(`load-chart-dialog`)
- 유료 기능 차단 화면 `paywall-*`, 가입 유도 화면 `regwall-*`(예: `regwall-indicators`, `paywall-study-limit`)

### 3.3 멀티 차트 레이아웃 [정적]

레이아웃 코드를 분할 트리로 정의한다. `h`는 가로 배치, `v`는 세로 배치, 숫자는 차트 index다.

| 코드 | 트리 |
|---|---|
| `s` | 단일 차트 (0) |
| `2h` | `["h",0,1]` |
| `2v` | `["v",0,1]` |
| `3h` | `["h",0,1,2]` |
| `3v` | `["v",0,1,2]` |
| `3s` | `["h",0,["v",1,2]]` |
| `3r` | `["h",["v",0,1],2]` |
| `2-1` | `["v",["h",0,2],1]` |
| `1-2` | `["v",0,["h",1,2]]` |
| `4v` `4h` `4s` `4s-l` `1-3` `3-1` `2-2` `2-2-l` `2-2-r` `1-4` | 4~5분할 변형 |
| `5h` `5v` `5s` `5s-l` `2-3` `3-2` `4-1` `2-3-l` `2-3-r` `6h` `6v` `6c` `2-4` `4-2` `4-3` `7h` `7s` | 5~7분할 |
| `8c` `8h` `8v` `9s` `5-4` `9h` `9v` `10c5` `10h` `10v` `12c6` `12c4` `12h` `14c7` `16c8` `16c4` | 8~16분할. 예: 8분할 그리드 `["v",["h",0,2,4,6],["h",1,3,5,7]]` |

레이아웃 코드는 총 55종이다. 실제로 쓸 수 있는 개수는 플랜의 `MULTIPLE_CHARTS` 한도로 제한된다.

- 차트 간 동기화(`layout-chart-sync` 청크, `LineToolsSynchronizer`): 심볼·인터벌·크로스헤어·시간·드로잉 동기화 [정적: 이름 기준, 세부 옵션은 미확인]
- 무료 플랜의 `MULTIPLE_CHARTS` 한도는 1이다(→ §11).

---

## 4. 차트 모델

### 4.1 객체 계층 [정적]

```
ChartWidgetCollection            레이아웃(s, 2h, …)과 차트 간 동기화
└ ChartWidget                    DOM/캔버스, 입력 처리, 그리기 예약
  └ ChartModel                   (ChartUndoModel이 감싸서 모든 변경을 Undo 명령으로 기록)
    ├ TimeScale                  모든 Pane이 공유하는 X축
    ├ Pane[]                     세로로 쌓이는 패널 (메인 + 지표 패널)
    │  ├ PriceScale[]            left / right / overlay 가격축
    │  └ DataSource[]            z-order 순서
    │     ├ Series               메인 시리즈 (심볼 + 인터벌 + 스타일)
    │     ├ Study                지표 (서버 계산, plot 데이터 보유)
    │     ├ LineTool             드로잉 (점 = time + price)
    │     └ Custom sources       그리드, 워터마크, 크로스헤어, 알림 라벨 등
    ├ Crosshair source
    ├ Selection / hovered source
    └ PointsetManager            드로잉 시간점 ↔ bar index 변환 (서버 pointset)
```

### 4.2 메인 시리즈 (Series)

**차트 스타일 enum `ChartStyle`** [정적]

| 값 | 이름 | 값 | 이름 |
|---:|---|---:|---|
| 0 | Bar | 11 | Range |
| 1 | Candle | 12 | HiLo |
| 2 | Line | 13 | Column |
| 3 | Area | 14 | LineWithMarkers |
| 4 | Renko | 15 | Stepline |
| 5 | Kagi | 16 | HLCArea |
| 6 | PnF | 17 | VolFootprint |
| 7 | LineBreak | 18 | TPO |
| 8 | HeikinAshi | 19 | VolCandle |
| 9 | HollowCandle | 20 | SVP |
| 10 | Baseline | 21 | HLCBars |

- 합성 스타일은 심볼 자체를 "스터디 심볼"로 감싸 서버에 요청한다. 서버 스터디 ID 예: `BarSetRenko@tv-prostudies`, `BarSetKagi@tv-prostudies`, `BarSetPnF@tv-prostudies`, `BarSetPriceBreak@tv-prostudies`, `BarSetHeikenAshi@tv-basicstudies`, `BarSetRange@tv-basicstudies`. 권한이 없으면 `study_not_auth:<id>` 오류가 오고 "차트 유형 사용 불가" 이벤트가 발생한다. [정적]
- Heikin Ashi는 `showRealLastPrice` 옵션으로 실제 마지막 가격선을 따로 표시할 수 있다. [정적]

**바 데이터 형식** [정적][관찰]
- `SeriesPlotIndex`: `Time=0, Open=1, High=2, Low=3, Close=4, Volume=5, Adt=6`
- 서버 바 예시: `{"i":0,"v":[1754659800.0, 220.83, 231.0, 219.25, 229.35, 113853967.0]}`. `v[0]`은 Unix 초 단위 bar 시작 시각이다.
- 가격 소스 함수: `open, high, low, close, hl2=(H+L)/2, hlc3=(H+L+C)/3, ohlc4=(O+H+L+C)/4`
- 값의 절댓값이 `1e100` 이상이면 "값 없음"(`undefined`)으로 바꾼다. 서버는 빈 값을 `1e+100`으로 채워 보낸다. [정적][관찰]

**PlotList (시계열 저장소)** [정적]
- index로 정렬된 배열이다. `merge(items)`가 갱신 형태를 판별한다.
  - 비어 있거나 새 마지막 index < 현재 첫 index → **prepend** (과거 데이터 로드)
  - 새 첫 index > 현재 마지막 index → **append** (새 바)
  - 항목 1개이고 index = 마지막 index → **updateLast** (실시간 틱으로 마지막 바 갱신)
  - 그 외 → 일반 병합
- `move(index_diff)`: 서버가 index를 다시 매기면(`index_diff` = `[old,new]` 쌍) 기존 항목의 index를 옮긴다.
- 최솟값/최댓값 캐시와 이진 탐색 캐시를 둔다.

**축소 표시 시 바 합치기(Conflation)** [정적] — bar 간격(px)이 아주 작아지면 여러 바를 합친 OHLC 청크를 미리 계산해 그린다.

| barSpacing 조건 | 합치는 바 수 |
|---|---:|
| > 0.03 | 10 |
| > 0.01 | 30 |
| > 0.003 | 100 |
| 그 외 | 500 |

### 4.3 TimeScale (X축) [정적]

| 항목 | 값/동작 |
|---|---|
| 기본 bar 간격 | 6px (VolFootprint 스타일은 82px) |
| 최소 bar 간격 | 0.5px |
| 최대 bar 간격 | 차트 폭 / 2 (`low_density_bars` 기능 플래그가 켜지면 차트 폭) |
| 최소 표시 바 수 | 2 (플래그가 켜지면 1) |
| 기본 우측 여백 | 10 bar (`rightOffsetDefaultValue`). 퍼센트 단위 여백 모드(`usePercentageRightOffset`) 지원 |
| 옵션 기본값 | `preserveBarSpacing=false`, `lockVisibleTimeRangeOnResize=false`, `rightBarStaysOnScroll=true` |
| 저장 상태 | `m_barSpacing`, `m_rightOffset`, `rightOffsetPercentage`, `usePercentageRightOffset`, `baseIndex`, points, tickmarks |

- **줌**: `zoom(x, delta)` → `newSpacing = spacing + delta × spacing / 10` (지수형 줌). `rightBarStaysOnScroll`이면 우측 끝을 고정하고, 아니면 커서 아래 index를 고정한다. 범위를 벗어난 간격은 최소/최대로 잘린다.
- **범위 맞춤**: `zoomToBarsRange(from, to)`는 폭 / (to − from + 1)로 간격을 정한다. 하단 타임프레임 버튼에 쓰인다. [추론]
- **실시간으로 이동**: `scrollToRealtime(animated)`는 1,000ms `easeInOutQuint` 애니메이션으로 우측 기본 여백 위치까지 이동한다.
- **보이는 범위**: `visibleBarsStrictRange`, `logicalRange`. 변경 이벤트는 `visibleBarsChanged`와 `logicalRangeChanged`.
- **과거 데이터 자동 로드**: 간격을 줄이거나 왼쪽으로 스크롤하면 `requestMoreData()`를 호출한다.
  - 요청 바 수 = `max(첫 바 index − 보이는 첫 바 index, 지표가 요구하는 추가 바 수)`
  - "이전 바 대비 색" 스타일이면 2를 더한다.
  - 로딩 중에는 중복 요청하지 않는다. 미래 영역이 보이면 `request_more_tickmarks`로 미래 시간 눈금을 요청한다.
- **time ↔ index 변환**: `timePointToIndex`, `indexToTimePoint`, `coordinateToIndex`, `indexToCoordinate`. 세션 사이 공백은 index가 연속이라 화면에 나타나지 않는다. `ComputedTimePointWeights`로 bar별 가중치를 두어 간격을 바꿀 수 있다.

### 4.4 PriceScale (Y축)

- **모드 enum** [정적]: `Normal=0, Log=1, Percentage=2, IndexedTo100=3`. 추가 플래그로 `autoScale`, `lockScale`, `inverted`.
- **기본 여백** [정적]: 위 10%, 아래 8% (`m_topMargin=0.1`, `m_bottomMargin=0.08`)
- **자동 스케일**: 보이는 범위의 소스 min/max(PlotList 캐시)로 범위를 정한다.
- **가격 범위 잠금**: 가격 대비 bar 비율을 고정하면 TimeScale의 최소/최대 bar 간격에 맞춰 가격 범위 한도(`priceRangeByScaleRatio`)를 다시 계산한다.
- **가격 포맷**: 심볼 정보의 `pricescale`/`minmov`/`minmove2`/`fractional`/`variable_tick_size`로 정한다(예: AAPL은 `pricescale=100, minmov=1`). [관찰]
- 축 라벨은 `alignLabels`로 겹치지 않게 정렬한다. 통화·단위 라벨과 스케일 모드 버튼(`price-scale-mode-buttons-renderer`)이 있다.
- `MergeAllScales`: 모든 스케일을 하나로 합치는 명령. [정적: 로거 이름]

### 4.5 크로스헤어·마그넷

- 크로스헤어 기본 속성 [정적]: 점선(`LINESTYLE_DASHED`), 폭 1, 투명도 0
- 마그넷 모드 [정적]: `WeakMagnet=0`, `StrongMagnet=1`. 드로잉 점을 가까운 OHLC 값에 붙인다. `magnetSnapsToIndicators` 옵션으로 지표 값에도 붙일 수 있다.
- 드로잉 기본값 [정적]: `magnetMode=WeakMagnet`, `stayInDrawingMode=false`, `drawOnAllCharts=true`
- 측정 도구: 크로스헤어 소스의 `startMeasurePoint`를 쓰고, 시간 구간은 서버 pointset으로 bar index를 계산한다(`_createMeasurePointset`).

### 4.6 실행 취소(Undo) [정적]

- `ChartUndoModel`이 모델 변경을 명령으로 감싸 `UndoStack`/`UndoHistory`에 넣는다(예: `RemoveSourcesUndoCommand`).
- 헤더의 ↶ ↷ 버튼과 연결된다(초기에는 비활성 [관찰]).

---

## 5. 렌더링 [정적]

### 5.1 캔버스 구조

- **모든 그리기는 Canvas 2D다.** 번들에 `getContext("webgl…")` 호출이 없다.
- 각 Pane, 가격축, 시간축 위젯이 **2개의 캔버스**를 가진다.
  - **메인 캔버스**: 배경, 그리드, 워터마크, 데이터 소스, 테두리
  - **탑 캔버스**: 크로스헤어, 그리는 중인 드로잉, 소스의 `topPaneViews`, 축 위의 크로스헤어 라벨
- 고해상도 디스플레이 대응: `devicePixelContentBoxSize`로 비트맵 크기를 맞춘다(`tryApplySuggestedCanvasBitmapSize`). 렌더러는 `MediaCoordinatesPaneRenderer`(CSS px)와 `BitmapCoordinatesPaneRenderer`(물리 px) 두 좌표계를 지원한다.

### 5.2 무효화와 다시 그리기

- `InvalidationLevel`: `None=0, Cursor=1, Light=2, Full=3`
- 변경이 생기면 `InvalidationMask`를 합쳐 두고 `requestAnimationFrame` 한 번으로 모아서 그린다(`_drawPlanned`, `_invalidationRAFCallback`). TimeScale 스크롤 애니메이션도 이 루프에서 진행한다.
- `Cursor` 레벨(마우스 이동)은 탑 캔버스만 다시 그리고, `Light`보다 높으면 메인 캔버스도 다시 그린다.
- 접힌(collapsed) Pane은 `Full`일 때만 그린다.
- 백그라운드 탭에서는 `timer.worker`로 타이머를 돌린다. 브라우저의 백그라운드 타이머 제한을 피하려는 것으로 보인다. [추론]

### 5.3 Pane 그리기 순서 (메인 캔버스)

1. 배경 → 그리드 소스 → 워터마크
2. Custom 소스(Background 레이어) → 일반 소스(시리즈·지표·드로잉, z-order) → Custom 소스(Foreground) → phantom 소스
3. 강조 대상(hover, 선택, 강조 plot이 있는 지표)을 맨 위에 다시 그림
4. 전략 소스(백테스트, 리플레이 전략) → 트레이딩 소스(주문·포지션 라인) → Custom 소스(Topmost)

**탑 캔버스**: `topPaneViews` → 크로스헤어 → 활성 드로잉(생성·편집·이동 중)

- 소스마다 `paneViews()`가 렌더러 목록을 돌려주는 MVC 구조다. 렌더러 종류: `CompositeRenderer`, `TrendLineRenderer`, `HHistRenderer`(가로 히스토그램), `TextRenderer` 등.
- 지표 그래픽 PaneView(`study-pane-views` 청크): `BackgroundPaneView`, `HHistPaneView`, `DwgLinePaneView`, `DwgBoxPaneView`, `DwgLabelPaneView`, `DwgPolylinePaneView`, `DwgTablePaneView`, `DwgLineFillPaneView` 등. Pine의 `line`/`box`/`label`/`polyline`/`table`/`linefill` 객체에 대응한다. [추론]

### 5.4 기본 색 [정적]

- 상승/하락 기본색은 `#089981` / `#F23645`.

---

## 6. 데이터 흐름과 서버 프로토콜

### 6.1 전송 계층

| 항목 | 내용 |
|---|---|
| 엔드포인트 | `wss://data.tradingview.com/socket.io/websocket` (환경 값 `WEBSOCKET_HOST`). 유료 플랜은 `prodata.tradingview.com`(`WEBSOCKET_PRO_HOST`), 재연결 3회 초과 시 `WEBSOCKET_HOST_FOR_RECONNECT`, 딥 백테스트는 `history-data.tradingview.com` [정적] |
| 쿼리 | `from=<경로>`, `date=<BUILD_TIME>`, `type=chart`, `auth=sessionid`, 선택적으로 `client=mobile`, `api_key`, `page-uri`, `ancestor-origin` [정적][관찰] |
| 프레이밍 | 메시지 하나 = `~m~<문자 길이>~m~<본문>`. 한 WebSocket 프레임에 여러 메시지를 이어 붙일 수 있다. 객체 본문은 `~j~` 접두사를 붙여 JSON으로 직렬화한다 [정적] |
| 핸드셰이크 | 서버의 첫 메시지(JSON)가 세션 정보다: `session_id`, `timestamp`, `timestampMs`, `release`, `studies_metadata_hash`, `auth_scheme_vsn`, `protocol:"json"`, `javastudies:["3.66"]` [관찰] |
| 하트비트 | 서버가 `~h~<n>`을 보내면 클라이언트가 같은 값으로 즉시 응답한다. 20초 동안 아무 데이터가 없으면 타임아웃(코드 4000, "socket.io timeout")으로 끊는다 [정적][관찰] |
| 재연결 | 끊긴 뒤 5초 후 재시도, 오프라인이면 `online` 이벤트를 기다린다. 최대 재연결·리다이렉트 각 20회. 연결 전 전송 요청은 큐에 쌓았다가 연결 후 보낸다 [정적] |
| 메시지 형식 | 요청과 응답 모두 `{"m": method, "p": [params…]}` (응답에 `t` 시간 필드가 붙을 수 있음) [정적][관찰] |
| 핑 | `WS_HOST_PING_REQUIRED`이면 `https://<host>/ping`을 최대 10회 호출해 RTT(min/max/avg)를 잰다 [정적]. 로그인 세션에서 `GET https://data.tradingview.com/ping`이 약 10초 간격으로 10회 호출됐다 [관찰-HAR] |
| 인증 | 익명은 `set_auth_token ["unauthorized_user_token"]` [관찰]. 로그인 사용자는 RS512 서명 JWT를 보내며, 유효 기간은 발급 후 4시간이다. 클레임: `user_id`, `plan`, `prostatus`, `perm`, `study_perm`, `fields_permissions`, `ext_hours`, `max_studies`, `max_charts`, `max_connections`, `max_fundamentals`, `max_study_on_study`, `max_active_alerts` 등 알림 한도 4종, `max_overall_alerts`, `max_alert_conditions`, `watchlist_symbols_limit`, `multiple_watchlists`, `multiflagged_symbols_lists`, `iat`, `exp` [관찰-HAR]. 플랜 한도(§11)를 데이터 서버가 이 토큰으로 강제하는 것으로 보인다 [추론] |
| 서버 시간 | `serverTime() = basePoint + performance.now()`, 응답 시간으로 지연을 보정한다 [정적] |

보조 채널 [관찰]
- `wss://pushstream.tradingview.com/message-pipe-ws/public`: 경제 이벤트 같은 공용 푸시
- `wss://pushstream.tradingview.com/message-pipe-ws/private_feed`: 로그인 사용자 개인 피드 [관찰-HAR]
- `https://notifications.tradingview.com/news/channel`: 뉴스 알림 EventSource

### 6.2 세션 유형

| 세션 | ID 접두사 | 용도 |
|---|---|---|
| Chart session | `cs_` + 무작위 12자 | 시리즈·지표·pointset·timescale. 차트 하나에 하나 |
| Quote session | `qs_<용도>_` + 무작위 12자 | 실시간 시세 필드 구독 |
| Replay session | (replay) | 바 리플레이 |
| Depth session | (depth) | 호가 깊이 |

**관찰된 Quote session 용도** [관찰]
- `qs_multiplexer_full_*`: 메인 심볼 전체 필드(재무·호가 포함)
- `qs_multiplexer_simple_*`: 범례와 헤더용 기본 필드
- `qs_multiplexer_watchlist_*`: Watchlist. 화면에 보이는 심볼만 `quote_fast_symbols`로 지정한다.
- `qs_snapshoter_<용도>_*`: 일회성 스냅샷. 받은 뒤 바로 `quote_remove_symbols`로 해제한다.
- 화면에 보이지 않는 세션은 `quote_hibernate_all`로 휴면시킨다.

Seasonals 위젯 같은 보조 차트는 `chart_create_session(id, "disable_statistics")`로 따로 세션을 연다. [관찰]

### 6.3 클라이언트 → 서버 메시지 [정적: 요청 빌더 전체 목록]

| 분류 | 메서드 (인자) |
|---|---|
| 공통 | `set_auth_token(token)`, `set_locale(lang, country)`, `set_data_quality("low")`, `set_broker(id)` |
| Chart | `chart_create_session(cs, flags)`, `chart_delete_session(cs)`, `switch_timezone(cs, tz)`, `resolve_symbol(cs, symId, symbol)`, `get_first_bar_time(cs, …)` |
| Series | `create_series(cs, seriesId, turnaround, symId, resolution, barsOrRange, timeframe)`, `modify_series(cs, seriesId, turnaround, symId, resolution, timeframe)`, `remove_series(cs, seriesId)`, `request_more_data(cs, seriesId, count)`, `request_more_tickmarks(cs, seriesId, count)`, `set_future_tickmarks_mode(cs, mode)` |
| Study | `create_study(cs, studyId, turnaround, parentId, studyName, inputs)`, `create_child_study(…)`, `modify_study(cs, studyId, turnaround, inputs)`, `remove_study(cs, studyId)`, `notify_study(…)`, `request_studies_metadata(reqId)` |
| Pointset | `create_pointset(cs, id, turnaround, symId, resolution, points)`, `modify_pointset`, `remove_pointset` |
| Quote | `quote_create_session`, `quote_delete_session`, `quote_set_fields(qs, …fields)`, `quote_add_symbols(qs, …symbols)`, `quote_remove_symbols`, `quote_fast_symbols`, `quote_hibernate_all` |
| Depth | `depth_create_session`, `depth_delete_session`, `depth_set_symbol`, `depth_clear_symbol`, `depth_set_scale` |
| Replay | `replay_create_session`, `replay_delete_session`, `replay_reset`, `replay_start`, `replay_stop`, `replay_step`, `replay_add_series`, `replay_remove_series`, `replay_set_resolution`, `replay_get_depth` |

### 6.4 서버 → 클라이언트 메시지 [정적][관찰]

| 메서드 | 내용 |
|---|---|
| `symbol_resolved` / `symbol_error` | 심볼 메타데이터. 세션·휴일(`session_holidays`), `pricescale`, `minmov`, `timezone`, `subsessions`, `currency_code`, `pro_name` 등 |
| `series_loading` → `timescale_update` → `series_completed` | 시리즈 로드. `series_completed`는 상태(`streaming`/`endofday`)와 `{rt_update_period: 5}` 같은 정보를 담는다 |
| `series_timeframe` | 범위 기반 요청 결과 `(seriesId, turnaround, fromIndex, toIndex, timeframe, completed)` |
| `series_error` | `study_not_auth:*`, `unsupported*`, `resolution_not_entitled`, `custom_resolution`, `seconds_not_entitled`, `ticks_not_entitled` 등 → 각각 권한·업그레이드 UI 이벤트로 바뀜 |
| `du` (= `data_update`) | 실시간 또는 추가 데이터. 객체 ID별로 `s`(series) 또는 `st`(study) 배열과 `ns`(non-series), `t`(turnaround), `lbs.bar_close_time` |
| `timescale_update` | 위 데이터 + 시간축 변경셋 `{index, zoffset, changes[], marks[[span,time,index]…], index_diff[[old,new]…], last_session_switches}` |
| `tickmark_update`, `index_update`, `clear_data` | 눈금 갱신, index 재매핑, 데이터 초기화 |
| `study_loading` / `study_completed` / `study_error` | 지표 상태 |
| `pointset_error` 등 | pointset 결과 |
| `qsd` (= `quote_symbol_data`) / `quote_completed` | 시세 필드 증분. `n`=심볼, `s`=상태, `v`=값. 짧은 키는 풀어서 쓴다(`lp`→`last_price`, `ch`→`change`, `chp`→`change_percent`) |
| `dd`, `dpu`, `depth_*` | 호가 깊이 |
| `protocol_error`, `critical_error`, `protocol_switched` | 프로토콜 오류와 전환 |

### 6.5 시퀀스: 차트 최초 로드 [관찰, AAPL 일봉, 익명]

```
C→S  set_auth_token ["unauthorized_user_token"]
C→S  set_locale ["en","US"]
C→S  chart_create_session ["cs_X", ""]
C→S  switch_timezone ["cs_X","Etc/UTC"]
C→S  quote_create_session / quote_set_fields / quote_add_symbols   (여러 용도 동시)
C→S  resolve_symbol ["cs_X","sds_sym_1","={\"adjustment\":\"splits\",\"symbol\":\"NASDAQ:AAPL\"}"]
C→S  create_series  ["cs_X","sds_1","s1","sds_sym_1","D",300,""]
C→S  request_studies_metadata ["metadata_1"]
S→C  series_loading ["cs_X","sds_1","s1"]
S→C  symbol_resolved ["cs_X","sds_sym_1",{…}]
S→C  timescale_update ["cs_X",{"sds_1":{"s":[{"i":0,"v":[t,o,h,l,c,v]},…300개],"ns":{…},"t":"s1","lbs":{…}}},{changeset}]
S→C  series_completed ["cs_X","sds_1","streaming","s1",{"rt_update_period":5}]
C→S  request_more_tickmarks ["cs_X","sds_1",10]               ← 우측 여백의 미래 눈금
S→C  timescale_update ["cs_X",{},{"index":300,"changes":[미래 10개 시각],"marks":[…]}]
C→S  create_study ["cs_X","4ZN4MR","st1","sds_1","Volume@tv-basicstudies-280",{"length":20,"col_prev_close":false}]
C→S  create_study … "Dividends@tv-basicstudies-280" / "Splits@…" / "Earnings@…" / "BarSetContinuousRollDates@tv-corestudies-50"  {"currenttime":"now"}
S→C  study_loading ["cs_X","4ZN4MR","s1_st1"]
S→C  du ["cs_X",{"4ZN4MR":{"st":[{"i":-1000100,"v":[t,vol,isUp,ma]},…],"ns":{"d":"","indexes":[]},"t":"s1_st1"}}]
S→C  study_completed ["cs_X","4ZN4MR","s1_st1"]
```

관찰된 세부 사항:
- **ID 규칙**: 시리즈 `sds_<n>`, 심볼 `sds_sym_<n>`, 지표는 무작위 6자, 지표 turnaround는 `<시리즈 turnaround>_<지표 turnaround>`(예: `s1_st1`).
- **확장 심볼 인코딩**: `"=" + JSON.stringify(키 정렬 객체)`. 키는 `symbol`, `session`, `adjustment`(기본 `splits`), `currency-id`, `unit-id`, `metric`, `backadjustment`, `settlement-as-close`, 리플레이용 `replay`, 스터디 심볼용 `inputs`/`type`. 단순 심볼은 문자열 그대로 보낸다. [정적]
- **초기 바 수**: `DEFAULT_NUMBARS = 300`. 날짜 범위 요청은 `["from_to", start, end]` 또는 `["bar_count", start, count]`. [정적][관찰]
- **지표 데이터 범위**: Volume 지표 index가 `-1000100`부터 시작했다. 시리즈 첫 바(index 0)보다 과거까지 계산하는 워밍업 구간이 음수 index로 온다. [관찰]
- 인터벌 문자열: 분 단위 정수(`"5"`, `"60"`), `D`/`1D`, `W`, `M`, 초 `S`, 틱 `T`, 레인지 `R`(예: `100R`). [관찰: `D`, `1D`, `5`] [정적: R, S, T 오류 처리]

### 6.6 시퀀스: 타임프레임/인터벌 변경 [관찰, 하단 `5D` 클릭]

```
C→S  modify_series ["cs_X","sds_1","s2","sds_sym_1","5","5"]    ← turnaround s1 → s2, 인터벌 5분
S→C  series_loading ["cs_X","sds_1","s2"]
S→C  timescale_update ["cs_X",{"sds_1":{"s":[],"t":"s2"}},{"index":0,"changes":[],"marks":[],"index_diff":[]…}]   ← 초기화
S→C  series_timeframe ["cs_X","sds_1","s2",0,389,"5",false]
S→C  study_loading × 5 (모든 지표가 "s2_st1"로 다시 계산)
S→C  timescale_update (5분봉 390개) → timescale_update (미래 눈금)
S→C  series_timeframe ["cs_X","sds_1","s2",0,389,"5",true]
S→C  series_completed ["cs_X","sds_1","streaming","s2",{"rt_update_period":5}]
S→C  du / timescale_update (지표별 재계산 결과) → study_completed × 5
```

- 지표는 클라이언트가 다시 요청하지 않는다. **부모 시리즈가 바뀌면 서버가 자식 지표를 자동으로 다시 계산해 보낸다.** [관찰]
- 클라이언트는 turnaround를 비교해 이전 세대(`s1`) 응답을 버린다(`_checkTurnaround`). 지표는 자기 turnaround, 시리즈 turnaround, `<시리즈>_<지표>` 결합형을 모두 받는다. [정적]

### 6.7 실시간 갱신 [정적][관찰][관찰-HAR]

- 거래 시간 중에는 `du`로 마지막 바(같은 index → `updateLast`)나 새 바(append)가 온다.
- 실제 장중 틱 예시(`TVC:SPX` 일봉, 로그인 무료 계정) [관찰-HAR]:

  ```
  << du ["cs_X",{"sds_1":{"s":[{"i":299,"v":[1792416600.0,7702.77,7703.82,7696.87,7703.82]}],
                           "ns":{"d":"","indexes":"nochange"},"t":"s1",
                           "lbs":{"bar_close_time":1792440599}}}]
  ```
  - 약 2분 동안 `du`가 24회, 대략 5~6초 간격으로 왔다. 모두 같은 index 299의 마지막 바를 고쳐 쓰는 갱신이다(시가 고정, 고가·저가·종가 변경).
  - `ns.indexes`가 `"nochange"`이면 non-series 데이터는 바뀌지 않았다는 뜻이다.
  - `lbs.bar_close_time`은 현재 바가 닫히는 시각(Unix 초)이다.
- 갱신 주기는 `series_completed`의 `rt_update_period`로 알려준다. 익명 사용자는 5초였고 범례에 "One update every 5 seconds"가 표시됐다. [관찰]
- 유료 플랜의 `TICK_BY_TICK_PUSH_DATA` 기능은 이 제한을 푸는 것으로 보인다. [추론]
- 시세 필드는 `qsd`로 바뀐 필드만 증분 전송된다(예: `{"v":{"lp":1.33258}}`). [관찰]

---

## 7. 레이아웃·드로잉 저장(REST)

### 7.1 레이아웃 (차트 상태 전체) [정적]

| 동작 | 요청 |
|---|---|
| 저장 | `POST /api/v1/charts/save/` (multipart). 필드: `name`, `symbol`, `short_name`, `symbol_type`, `exchange`, `resolution`, `content`, `study_meta_info_map`, `image_url`(id). `content`와 `study_meta_info_map`은 **`async-gzip.worker`로 gzip 압축한 Blob**(`blob.gz`)으로 보낸다. 응답은 `{id, image_url, last_modified}` |
| 불러오기 | 페이지 URL `/chart/<url>/`로 열면 **서버가 HTML 안에 레이아웃을 넣어 보낸다**: `initData.content = {…}`, `initData.study_meta_info_map`, `initData.uid`, `chart_id`, `name`, `description`, `readOnly`, `defSymbol`, `defInterval`, `defMetric` 등 [관찰-HAR]. 이미 열린 페이지에서 다른 레이아웃으로 바꿀 때는 `GET /chart/<url>/json/`을 쓰고, 비어 있으면 Volume 지표가 붙은 단일 차트를 만든다 [정적] |
| 목록/개수/삭제 | `GET /my-charts/?limit=`, `GET /api/v1/charts/count/`, `POST /api/v1/charts/delete/ {"uid":[…]}` |
| 공유 | `/api/v1/charts/<id>/sharing/` |
| 오류 코드 | `saved_chart_limit_reached`, `login_required` → 업그레이드·로그인 유도. 5xx 또는 `disabled_temporarily` → 경고 표시 |

저장된 레이아웃 `content` 구조. 실제 저장본(단일 차트, `TVC:SPX` 일봉 캔들)에서 확인했다 [관찰-HAR].

```jsonc
{
  "name": "Unnamed",
  "layout": "s",                       // §3.3 레이아웃 코드
  "charts": [{
    "chartId": "1", "version": 3, "timezone": "Etc/UTC", "linkingGroup": null,
    "shouldBeSavedEvenIfHidden": true,
    "panes": [{
      "mode": 0, "mainSourceId": "_seriesId", "stretchFactor": 2000,   // Pane 세로 비율 가중치
      "isCollapsed": false, "isMaximized": false, "priceScaleRatio": null,
      "leftAxisesState": [], "overlayPriceScales": {},
      "rightAxisesState": [{
        "state": { "id": "<scaleId>", "m_priceRange": null, "m_isAutoScale": true,
                   "m_isPercentage": false, "m_isIndexedTo100": false, "m_isLog": false,
                   "m_isLockScale": false, "m_isInverted": false,
                   "m_topMargin": 0.1, "m_bottomMargin": 0.08, "alignLabels": true,
                   "logFormula": { "logicalOffset": 4, "coordOffset": 0.0001 },
                   "hasCalculatedPriceRange": true },
        "sources": ["_seriesId"] }],
      "sources": [{
        "type": "MainSeries", "id": "_seriesId", "zorder": 0,
        "haStyle":   { "studyId": "BarSetHeikenAshi@tv-basicstudies-60" },
        "renkoStyle":{ "studyId": "BarSetRenko@tv-prostudies-73" },
        "pbStyle":   { "studyId": "BarSetPriceBreak@tv-prostudies-34" },
        "kagiStyle": { "studyId": "BarSetKagi@tv-prostudies-73" },
        "pnfStyle":  { "studyId": "BarSetPnF@tv-prostudies-73" },
        "rangeStyle":{ "studyId": "BarSetRange@tv-basicstudies-72" },
        "svpStyle":  { "studyId": "VbPSessions@tv-volumebyprice-126" },
        "volFootprintStyle": { "studyId": "Footprint@tv-volumebyprice-104" },
        "tpoStyle":  { "studyId": "TPOSessions@tv-volumebyprice-104" },
        "formattingDeps": { "pricescale": 100, "minmov": 1, "fractional": false,
                            "minmove2": 0, "variable_tick_size": "0.01" },
        "studyBindings": { … },
        "state": { "style": 1, "symbol": "TVC:SPX", "interval": "D", "timeframe": …,
                   "candleStyle": { "upColor": "#089981", "downColor": "#F23645",
                                    "wickUpColor": "#089981", "wickDownColor": "#F23645",
                                    "borderUpColor": "#089981", "borderDownColor": "#F23645",
                                    "drawWick": true, "drawBorder": true, "drawBody": true,
                                    "barColorsOnPrevClose": false, … },
                   "barStyle": {…}, "lineStyle": {…}, "areaStyle": {…}, …,   // 모든 스타일 설정을 함께 저장
                   "showPriceLine": …, "prePostMarket": …, "sessionId": …,
                   "dividendsAdjustment": …, "currencyId": …, "unitId": …, "metricId": …,
                   "priceAxisProperties": {…} } }]
      // 지표가 있으면 같은 sources 배열에 type "Study…" 항목으로 들어간다 [추론]
    }],
    "timeScale": { "m_barSpacing": 3.9366, "m_rightOffset": 10,
                   "rightOffsetPercentage": 5, "usePercentageRightOffset": false },
    "chartProperties": {
      "paneProperties": { "backgroundType": "solid", "topMargin": 10, "bottomMargin": 8,
                          "vertGridProperties": { "style": 1, "visible": true, "color": "rgba(46, 46, 46, 0.2)" },
                          "horzGridProperties": { … },
                          "crossHairProperties": { "style": 2, "transparency": 0, "width": 1, "color": "#9C9C9C" },
                          "axisProperties": { "autoScale": true, "log": false, "percentage": false, … },
                          "legendProperties": {…}, … },
      "scalesProperties": { "fontSize": …, "showSeriesLastValue": …, "barSpacing": …, … },
      "tradingProperties": { "showPositions": …, "showOrders": …, "showExecutions": …, … },
      "chartEventsSourceProperties": { "visible": …, "futureOnly": …, "breaks": … },
      "publishedChartsTimelineProperties": {…},
      "priceScaleSelectionStrategyName": "auto", "inactivityGaps": false },
    "sessions": { "properties": { "sessionHighlight": { "backgrounds": {
                    "preMarket":  { "color": "#FF9800", "transparency": 92 },
                    "postMarket": { "color": "#2962FF", "transparency": 92 }, … } } } }
  }],
  "symbolLock": 0, "intervalLock": 0, "trackTimeLock": 0, "dateRangeLock": 0, "crosshairLock": 1,
  "layoutsSizes": { "s": [ { "percent": 1 } ] },
  "symbolAliasServiceState": []
}
```

- 메인 시리즈에는 합성 차트 스타일별 서버 스터디 ID와 버전(예: `BarSetRenko@tv-prostudies-73`)이 함께 저장된다. 스타일을 바꿀 때 이 ID로 `create_series`의 스터디 심볼을 만든다(§4.2). [관찰-HAR][추론]
- 차트 간 잠금(`symbolLock`, `intervalLock`, `trackTimeLock`, `dateRangeLock`, `crosshairLock`)은 레이아웃 최상위에 저장된다. §3.3의 차트 동기화 설정이다.
- **드로잉은 `content`에 들어 있지 않다.** 이 레이아웃에 Ray 드로잉이 하나 있었지만, 그 데이터는 §7.2의 charts-storage에서만 왔다. [관찰-HAR]
- 저장 목록 `GET /my-charts/` 응답 항목: `id`, `image_url`(= 레이아웃 URL id), `name`, `symbol`, `pro_symbol`, `short_name`, `resolution`/`interval`, `created`, `modified`, `created_timestamp`, `modified_iso`, `url`, `favorite` [관찰-HAR]

### 7.2 드로잉 (charts-storage) [정적]

레이아웃 본문과 **분리해서** 심볼 단위로 저장한다.
- 베이스 URL: `<link rel="chart-storage">` → `https://charts-storage.tradingview.com/charts-storage/`
- 토큰: `GET /chart-token/?image_url=<layoutId>&user_id=<id>` → JWT
- 저장: `PUT <path>?layout_id=&chart_id=&jwt=` (JSON). 헤더에 `X-BUILD-TIME`이 붙는다. 429 응답이면 재시도를 늦춘다.
- 불러오기: `GET get/<path>?layout_id=&chart_id=&jwt=&symbol=…`. 요청 유형은 3가지다.
  - `mainSeriesLineTools`: 메인 시리즈 심볼의 드로잉
  - `studiesLineTools`: 지표에 붙은 드로잉
  - `lineToolsWithoutSymbol`: 심볼과 무관한 드로잉
- 삭제: `DELETE <path>?layout_id=&symbol=&jwt=`
- 공유 범위 `SharingMode`: `NotShared=0`(차트별), `SharedInLayout=1`(레이아웃 안 공유, chartId `_shared`), `GloballyShared=2`(모든 레이아웃 공유)

실제 불러오기 흐름. 레이아웃 `4fv3f4cL`, 심볼 `TVC:SPX`에서 확인했다 [관찰-HAR].

```
GET  /chart-token/?image_url=<layoutId>&user_id=<id>   → {"token":"<JWT>"}   (페이지 로드 중 9회 호출)
GET  charts-storage/get/user/sources?layout_id=…&jwt=…&symbol=                         ← GloballyShared, 심볼 무관
GET  charts-storage/get/layout/<id>/sources?chart_id=1&…&symbol=&includeOwnerSource=_seriesId   ← NotShared
GET  charts-storage/get/layout/<id>/sources?chart_id=1&…&excludeOwnerSource=_seriesId          ← 지표에 붙은 드로잉
GET  charts-storage/get/user/sources?…&symbol=TVC:SPX&brokerName=
GET  charts-storage/get/layout/<id>/sources?chart_id=_shared&…&symbol=TVC:SPX&brokerName=      ← SharedInLayout
```

- charts-storage JWT 클레임: `type`, `layoutId`, `ownerId`, `shared`, `iss`, `iat`, `exp`. 유효 기간은 약 10일(14,460분)이다.
- 응답 형식은 `{"success":true,"payload":{…}}`이다. 바뀐 게 없으면 `304`와 빈 `payload`가 온다(조건부 요청 캐시).
- 드로잉 DTO 예시(Ray, 값 일부 생략):

```json
{ "success": true, "payload": { "sources": { "o8Sxvx": {
  "id": "o8Sxvx", "symbol": "TVC:SPX", "ownerSource": "_seriesId",
  "serverUpdateTime": 1792416705286,
  "state": {
    "type": "LineToolRay", "id": "o8Sxvx",
    "state": { "linecolor": "#2962FF", "linewidth": 2, "linestyle": 0,
               "extendLeft": false, "extendRight": true,
               "showPriceRange": false, "showBarsRange": false, "showAngle": false, "statsPosition": 2,
               "text": "", "fontsize": 14, "bold": false, "italic": false,
               "interval": "D", "symbol": "TVC:SPX", "currencyId": null, "unitId": null, "metricId": "price",
               "visible": true, "frozen": false, "title": "",
               "symbolStateVersion": 2, "zOrderVersion": 2, "adjustedToSplitTime": 1792416702.501, … },
    "points": [ { "time_t": 1785331800, "offset": 0, "price": 7316.16, "interval": "D" },
                { "time_t": 1789565400, "offset": 0, "price": 7507.77, "interval": "D" } ],
    "zorder": -5000, "ownerSource": "_seriesId", "linkKey": "XwLTETRWa3f4", "sharingMode": 1 } } } } }
```

- 드로잉의 기준 키: `ownerSource`(붙어 있는 소스, 보통 메인 시리즈 `_seriesId`), `symbol`, `sharingMode`, `linkKey`(차트 간 동기화 키), `zorder`(드로잉은 음수 영역).
- 점은 `time_t`(바 시작 시각) + `offset`(바 개수 오프셋) + `price` + 기록 당시 `interval`로 저장한다. 인터벌과 무관하게 같은 위치를 복원하려는 설계로 보인다. [추론]
- 분할 조정 기준 시각(`adjustedToSplitTime`)을 기록해 둔다. 주식 분할 뒤에 가격을 보정하는 데 쓰는 것으로 보인다. [추론]

### 7.3 템플릿 [정적]

- 지표 템플릿: `GET/POST /api/v1/study-templates`, `…/<id>`, `…/<id>/rename/`, `…/<id>/favorite`, `…/standard/<id>`
- 드로잉 템플릿: `GET /drawing-templates/<tool>/`, `GET /drawing-template/<tool>/?templateName=`, `POST /save-drawing-template/`, `POST /remove-drawing-template/`

---

## 8. 지표 계산

### 8.1 계산 위치 [정적][관찰]

**모든 지표는 서버의 차트 세션 안에서 계산된다.** 클라이언트의 `StudyDataSource`가 하는 일은 다음과 같다.
1. 부모 시리즈의 `instanceId`가 생기길 기다린다. 시리즈가 아직 없으면 `created` 이벤트를 구독한다.
2. 메타정보에서 최신 버전 ID를 정한다(`getStudyIdWithLatestVersion`) → `create_study(cs, studyId, turnaround, parentSeriesId, "<Name>@<package>-<version>", inputs)`
3. `study_loading` → `du`/`timescale_update`로 plot 배열을 받아 `PlotList.merge` → `study_completed`
4. 연결이 끊기면 상태를 되돌리고, 다시 연결되면 지표를 새로 만든다.

클라이언트 번들에서는 이동평균 같은 지표 계산식(예: EMA의 `2/(n+1)`)이 발견되지 않았다. 클라이언트 쪽 연산은 아래로 한정된다. [정적, 탐색 범위: 다운로드한 109개 파일]
- 가격 소스 파생값(`hl2`, `hlc3`, `ohlc4`)
- 축소 표시용 OHLC 합치기(§4.2)
- 지표 그래픽(ZigZag·Pivot·Elliott·SVP 같은 `study-*` 청크의 렌더러)

### 8.2 지표 ID 체계

| 형식 | 예 | 의미 |
|---|---|---|
| `<Name>@tv-basicstudies[-ver]` | `Volume@tv-basicstudies-280`, `Compare@…`, `Overlay@…`, `RegressionTrend@…`, `AnchoredVWAP@…`, `VbPFixed@…` | 서버 내장 "Java" 지표 (`javastudies` 3.66) [관찰][정적] |
| `<Name>@tv-prostudies` | `BarSetRenko@tv-prostudies` | 유료 패키지 |
| `<Name>@tv-corestudies-ver` | `BarSetContinuousRollDates@tv-corestudies-50` | 내부 보조 |
| 기타 패키지 | `tv-volumebyprice`, `tv-chartpatterns`, `tv-optionstudies` | 플랜 기능으로 권한 제어 (§11) |
| `STD;<Name>` | `STD;RSI`, `STD;MACD`, `STD;Bollinger_Bands`, `STD;EMA`, `STD;SMA` … (50종 이상) | **Pine으로 작성된 표준 내장 지표.** 지표 대화상자의 "Relative strength index" 항목은 `data-id="STD;RSI"`다 [관찰] |
| `Script$<id>@tv-scripting` | `Script$TV_EARNINGS@tv-scripting` | 컴파일된 Pine 스크립트 실행체 |
| `PUB;…` / `USER;…` | 커뮤니티 공개 / 사용자 스크립트 | [추론: ID 접두사 체계] |

- 메타정보 저장소(`StudyMetaInfoRepository`)는 `request_studies_metadata`(WebSocket)와 `/chart-api/studies_metadata` REST로 내장 지표 메타정보를 받는다. 핸드셰이크의 `studies_metadata_hash`로 캐시 유효성을 확인하는 것으로 보인다. [정적][추론]
- `StudyMigration`/`Chart.Study.Versioning`: 저장된 레이아웃의 옛 지표 버전을 새 버전으로 바꾼다.

### 8.3 Pine 스크립트 파이프라인 [정적][관찰]

```
지표 대화상자
   │ GET pine-facade/list?filter=standard|candlestick|fundamental   ← 목록 [관찰]
   ▼
pine-facade.tradingview.com/pine-facade/
   ├ translate/<scriptId>/<version>       저장된 스크립트 → 메타정보 + 컴파일 결과
   ├ translate_source/<ver>  (POST source, inputs)   편집기 소스 직접 컴파일
   ├ get/<id>/<ver>, versions/<id>[/last], is_auth_to_get/<id>/<ver>
   ▼
metaInfo (inputs에 컴파일 결과를 담는 "text" 입력이 반드시 있음; 없으면 검증 오류 로그)
   ▼
create_study(…, "Script@tv-scripting-…", { text: <컴파일 결과>, 사용자 입력… })
   ▼
서버에서 실행 → du (plots + non-series 그래픽)
```

- 결과는 `translate` 요청 키(`<id>-<version>`)별로 캐시한다. 버전이 음수(옛 스크립트)면 캐시를 무효화한다.
- 메타정보 `fullId`의 패키지가 `tv-scripting`이면 `{type:"pine", pineId}`로 분류한다.

### 8.4 지표 출력 데이터

- **Series plot**: `st: [{i, v:[time, plot0, plot1, …]}]`. `studyPlotFunctionMap`이 메타정보 `plots[k].id`를 `v[k+1]`에 연결한다. `null`/`undefined`는 빈 값.
  - 예: Volume `[time, volume, 방향(0/1), MA]` [관찰]
- **Non-series 데이터(`ns`)**: `{d: "<JSON 문자열>", indexes: [...]}`. 박스·라인·라벨·테이블 같은 그래픽 객체와 보조 데이터가 들어간다. `wireFormat.unpackNonSeriesData`로 풀고, `d`가 빈 문자열이면 변경 없음이다. Seasonals 지표는 `d`에 월별 성과 JSON이 들어 있었다. [관찰]
- 일본식 차트(Renko 등)의 투영 바는 `ns.d.data.bars[{time, open, high, low, close, volume, factor|additionalPrice}]`로 오고 `boxSize`/`reversalAmount`가 함께 온다. [정적]
- 지표 상태 enum: `Undefined / Loading / Completed / Error`. 내부 상태 머신은 0 → 1(연결 대기) → 2(시리즈 대기) → 3(생성 요청) → 4(Active). [정적]

### 8.5 지표 위의 지표·드로잉형 지표

- **Study-on-study**: `create_child_study`로 다른 지표의 출력을 입력으로 쓴다. 플랜 한도는 `STUDY_ON_STUDY {limit:800, child_limit:1}`. [정적]
- **드로잉형 지표(Study line tool)**: Anchored VWAP, Regression Trend, Fixed Range Volume Profile, 차트 패턴 등은 드로잉처럼 배치하지만 계산은 서버 지표(`AnchoredVWAP@tv-basicstudies`, `RegressionTrend@…`, `VbPFixed@…`)로 한다. 앵커가 바뀌면 `recalcStudyIfNeeded`로 다시 계산한다. [정적]

### 8.6 익명 사용자 제한 [관찰]

- 지표 대화상자 목록(`list?filter=standard`)은 보인다. 하지만 항목을 클릭하면 **"Access over 100,000 trading indicators … You'll need a free account" 모달**이 뜨고 `create_study`를 보내지 않는다.
- 그래서 `STD;RSI`의 `create_study` 실제 인자(Pine 컴파일 결과 포함)는 이번 분석에서 관찰하지 못했다(§12).

---

## 9. 드로잉 도구 [정적: 청크 이름][관찰: 툴바]

### 9.1 도구 목록 (지연 청크 `line-tool-*`)

| 분류 | 도구 |
|---|---|
| 선 | trend-line, trend-angle, horizontal-line, horizontal-ray, vertical-line, cross-line, arrow-marker, path, poly-line, sine-line, cyclic-lines, time-cycles |
| 채널 | parallel-channel, disjoint-channel, flat-bottom, regression-trend, pitchfork |
| Fib/Gann | fib-retracement, trend-based-fib-extension, trend-based-fib-time, fib-channel, fib-circles, fib-spiral, fib-speed-resistance-arcs, fib-speed-resistance-fan, fib-timezone, fib-wedge, gann-square, gann-fixed, gann-fan, gann-complex |
| 패턴 | 5points-patterns(XABCD), abcd, head-and-shoulders, three-drivers, triangle-pattern, elliott |
| 예측·측정 | position(Long/Short), risk-reward, prediction, projection, bars-pattern, ghost-feed, price-label, anchored-vwap, volume-profile |
| 도형 | rectangle, rotated-rectangle, circle, ellipse, triangle, arc, bezier-quadro, bezier-cubic, brush |
| 주석 | text-note, note, callout, comment, price-note, signpost, flag-mark, arrow-mark, table, image, emoji, sticker, icon, tweet, idea |
| 트레이딩 | order (주문 라인) |

### 9.2 동작

- 점 모델: 각 점은 `(time, price)`다. 아직 바가 없는 미래 시간은 오프셋으로 표현하고, 서버 **pointset**으로 bar index를 받아 배치한다. [정적] 실제 메시지는 다음과 같다 [관찰-HAR].

  ```
  >> create_pointset ["cs_X","pointset_1","turnaround","sds_sym_1","D",[1785331800,0,"D"],[1789565400,0,"D"]]
  << du ["cs_X",{"pointset_1":{"plots":[{"index":0,"value":[242,1785331800]},
                                         {"index":1,"value":[276,1789565400]}],"t":"turnaround"}}]
  ```
  - 요청 점 하나 = `[time_t, offset, interval]`. 응답 `value` = `[bar index, time_t]`.
  - 저장된 Ray 드로잉의 두 점(§7.2)이 메인 시리즈 index 242와 276으로 바뀌었다. 레이아웃을 열 때 드로잉을 그리기 전에 이 변환을 거친다.
- 생성 흐름: 툴 선택 → 클릭으로 점 추가(`continueCreatingLine`) → 마지막 점에서 완료(`_finishTool`). 브러시처럼 드래그하는 도구(`isLineDrawnWithPressedButton`)는 버튼을 누른 채 그린다. Esc는 `cancelCreatingLineTool`. [정적]
- 마그넷(§4.5), "계속 그리기"(`stayInDrawingMode`), 모든 차트에 그리기(`drawOnAllCharts`), 잠금·숨김·일괄 삭제(툴바 [관찰])
- 그룹(`LineToolsGroup`, 중첩 그룹은 유료 기능 `NESTED_DRAWING_GROUPS`), 객체 트리 패널, 템플릿(§7.3)
- 드로잉 위에 알림을 만들 수 있다(`LineToolAlertBinding`, `createAddAlertAtSourceAction`). [정적]
- 저장은 §7.2(charts-storage), 차트 간 동기화는 `LineToolsSynchronizer`.

---

## 10. 기타 기능 (요약)

| 기능 | 근거 | 요지 |
|---|---|---|
| 바 리플레이 | [정적] | 별도 replay 세션(`replay_*`). 리플레이 심볼은 `{replay: <sessionId>, symbol: …}`로 감싼다. 인트라데이·초·틱 단위 리플레이는 유료 (`paywall-bar-replay-*`) |
| 심볼 비교·오버레이 | [정적] | `Compare@tv-basicstudies`, `Overlay@tv-basicstudies` 서버 지표 |
| 실적·배당·분할 마커 | [관찰] | 차트를 열면 자동으로 `Earnings/Dividends/Splits@tv-basicstudies`를 `{"currenttime":"now"}`로 생성. 시간축 아래 E/D 아이콘으로 표시 |
| 시간대 | [관찰] | `switch_timezone(cs, "Etc/UTC")`. 하단 바에서 바꾼다 |
| 세션 (RTH/ETH) | [관찰] | 심볼의 `subsessions`(regular, pre, post, night 등) 중에서 고르고, 확장 심볼의 `session` 키로 서버에 전달 |
| 알림 | [정적] | `pricealerts.tradingview.com`, `chart-alerts-facade` 청크 |
| 스냅샷 | [정적] | 각 위젯의 `getImage()`가 분리된 캔버스에 다시 그려서 합성. 업로드는 `/charts/uploads/generate-link/` |
| 텔레메트리 | [관찰][정적] | `snowplow-pixel.tradingview.com`, 연결·로딩 시간 지표(`TimingsMeter`, `ChartApi.TrafficMeter`) |

---

## 11. 플랜별 기능 한도 [정적: 번들에 내장된 기본 설정]

| 기능 키 | free | pro |
|---|---:|---:|
| `INDICATORS_ON_CHART` | 2 | 5 |
| `MULTIPLE_CHARTS` (레이아웃당 차트 수) | 1 | 2 |
| `CHART_STORAGE` (저장 레이아웃 수) | 1 | 5 |
| `HISTORICAL_BARS` | 5 | 10 |
| `FUNDAMENTALS_ON_CHART` | 1 | 4 |
| `STUDY_TEMPLATES` | 1 | — |
| `SAVED_PINE_SCRIPTS` | 1 | 99999 |
| `SERVER_SIDE_ALERTS` (limit) | 3 | 20 |
| `WATCHLIST_SYMBOLS` | 30 | — |
| `BACKEND_CONNECTIONS` | 2 | — |
| 지표 패키지 | `tv-optionstudies` | + `tv-chartpatterns`, `tv-volumebyprice` |
| 기타 pro 기능 | — | `CUSTOM_INTERVALS`, `TICK_BY_TICK_PUSH_DATA`, `DRAWINGS`, `NESTED_DRAWING_GROUPS`, 백테스트 확장 등 |

- `HISTORICAL_BARS` 단위는 1,000 bar로 보인다(free 5K bar). [추론]
- 일부 브로커·거래소 파트너 환경(cme, bovespa 등)은 `INDICATORS_ON_CHART`를 99999로 덮어쓴다.
- "—"는 이번에 읽은 범위에서 값을 확인하지 못했다는 뜻이다.

---

## 12. 미확인 사항과 한계

| 항목 | 상태 | 이유 / 다음 단계 |
|---|---|---|
| Pine 지표(`STD;RSI` 등)의 `create_study` 실제 인자, `modify_study`/`remove_study` | 미관찰 | 익명은 가입 유도 모달에 막혔고, 로그인 HAR에는 마지막 새로고침 이후만 들어 있었다. "Preserve log"를 켠 상태에서 지표 추가부터 다시 녹화해야 한다 |
| 레이아웃 저장 요청(`POST /api/v1/charts/save/`)과 드로잉 저장(`PUT charts-storage`) | 미관찰 | 위와 같은 이유. 저장 결과물(`initData.content`, 드로잉 DTO)은 §7에서 확인했다 |
| 장중 실시간 `du` 틱의 실제 형태 | **확인됨** | 로그인 HAR에서 5~6초 간격의 마지막 바 갱신을 확인했다(§6.7) |
| 레이아웃 `content` JSON 구조 | **확인됨** (지표 항목 제외) | 저장된 레이아웃에 지표가 없어 지표 소스의 저장 형식은 미확인 |
| 서버의 지표 계산 알고리즘 | 범위 밖 | 서버 측 구현이라 클라이언트 분석으로는 알 수 없다. 표준 지표 정의는 공개 Pine 소스(`STD;*`)를 참고 |
| `14041.*.js` 의미 분석 | 부분 | 분석기 힙 한도. 정적 사실(문자열·구조)만 남음 |
| 지연 청크 전수 분석 | 부분 | 차트 관련 52개 청크만 받았다. 전체 이름 있는 청크는 1,035개 |
| 차트 동기화 옵션·단축키 목록 | 미분석 | 이번 범위에서 제외 |

- 정적 분석은 코드가 존재함을 보여줄 뿐, 실행 경로를 증명하지 않는다. [정적] 항목 중 런타임에서 확인한 것은 [관찰]을 같이 붙였다.
- 수치·ID·엔드포인트는 2026-10-19 배포 기준이며, 배포마다 바뀔 수 있다.

---

## 부록 A. 근거 목록 (REA Evidence)

| 근거 | Evidence ID | 내용 |
|---|---|---|
| JS 애플리케이션 그래프 | `ev_ef4423e2…e71d` (CLI 실행본 `ev_bfe18cdc…cdea`) | 109개 파일 정적 분석, 엔드포인트·워커·스토리지 후보 |
| 차트 최초 로드 | `ev_df4208eb…c270` | WebSocket 프레임 78개, 네트워크 703 요청, 스크린샷, 접근성 트리 |
| 타임프레임 5D 변경 | `ev_8a3decee…3db5` | `modify_series` → 지표 자동 재계산 |
| 지표 대화상자 / 검색 | `ev_e124b544…1a61`, `ev_93696dad…92ea` | 대화상자 구조, `RSI` 검색 결과 |
| 지표 항목 DOM | (DOM 캡처) | `data-role="list-item" data-id="STD;RSI"` |
| 지표 추가 시도 | `ev_c90b2302…10d9` | `pine-facade/list?filter=*` 요청, 가입 유도 모달 |
| 로그인 세션 HAR | (사용자 제공 파일, 저장소 미포함) | 저장된 레이아웃 열기, `initData.content`, charts-storage 드로잉 DTO, pointset, 실시간 `du` 24회, 인증 JWT 클레임 이름 |

## 부록 B. 재현 절차

1. 차트 페이지 HTML에서 `static.tradingview.com/static/bundles/*.js`를 수집하고, `runtime.*.js`의 `_.u` 청크 맵에서 이름 있는 청크 URL을 만든다.
2. `npx -y rea-agents@6.7.0 analyze-javascript-application <dir> --json`으로 정적 그래프를 만든다.
3. 헤드리스 Chromium을 `--proxy-server` + `--remote-debugging-port`로 띄우고, REA `capture_browser_scenario`(connect 모드)에서 `events: ["websockets"]`로 프레임을 캡처한다.
4. 프레임을 `~m~<len>~m~` 단위로 나눈 뒤 JSON `{m,p}`로 해석한다.
