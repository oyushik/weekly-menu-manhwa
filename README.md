# 호야쿡스 주간식단표 → Discord

[호야쿡스 주간식단표](https://www.hoyacooks.com/WeeklyMenu/)에서 **한국만화영상진흥원 주간식단표** 새 글을 찾아 본문 이미지를 Discord 채널에 파일로 첨부하는 봇입니다. Node.js 24와 GitHub Actions를 사용합니다. 별도 서버나 Discord 봇 계정은 필요 없습니다.

## 동작

- 매시 **7·22·37·52분**에 확인합니다. 첫 실행은 최신 글 하나만 보내고, 이후 새 글은 오래된 순서로 보냅니다.
- 본문의 JPG/PNG/GIF/WebP 이미지를 등장 순서대로 모아 **게시글당 메시지 하나**에 함께 첨부합니다. 제목, 이미지 장수, 원문 링크가 함께 표시됩니다. 사이트 로고·배너·댓글 이미지는 제외합니다.
- 전송 기록은 저장소의 `bot-state` 브랜치에 저장합니다. 같은 글은 다시 보내지 않으며, 이미지 다운로드나 메시지 전송이 실패하면 다음 실행에서 해당 글을 재시도합니다. 이전 버전의 이미지별 전송 기록도 유지합니다.
- 잠시 실행이 중단되어 새 글이 다음 페이지로 넘어가도 탐색합니다. 새 글 판별에는 게시판의 증가하는 `idx`를 사용합니다. 기존 글의 수정은 알리지 않습니다.
- 본문이나 이미지가 없거나 사이트 구조가 바뀌면 실패로 표시하고 다음 실행에서 다시 시도합니다. 실패한 글을 완료 처리하지 않습니다.

## GitHub Actions 설정

1. 이 폴더의 파일을 GitHub 저장소의 기본 브랜치(보통 `main`)에 올립니다. `.github/workflows/weekly-menu.yml`과 `package-lock.json`도 포함해야 합니다. `node_modules`, `.env`, `data`는 올리지 않습니다.
2. 알림을 받을 **Discord 텍스트 채널**에서 **채널 편집 → 연동(Integrations) → 웹훅(Webhooks)**으로 이동해 웹훅을 만들고 URL을 복사합니다. 웹훅 관리 권한이 필요합니다. [Discord 공식 안내](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
3. [GitHub Secret 등록 화면](https://github.com/oyushik/weekly-menu-manhwa/settings/secrets/actions/new)에서 다음 값을 등록합니다.

   | 이름 | 값 |
   | --- | --- |
   | `DISCORD_WEBHOOK_URL` | 복사한 Discord 웹훅 URL |

   웹훅 URL은 채널에 글을 쓸 수 있는 비밀 값이므로 코드·커밋·채팅에 넣지 마세요.

4. **Settings → Actions → General**에서 Actions 실행이 허용되어 있는지 확인합니다. 워크플로는 `contents: write`를 요청합니다. 조직 정책이나 브랜치 규칙이 있다면 `bot-state` 생성·푸시를 허용해야 전송 기록을 저장할 수 있습니다. 개인 액세스 토큰은 필요 없습니다.
5. [Weekly menu to Discord 실행 화면](https://github.com/oyushik/weekly-menu-manhwa/actions/workflows/weekly-menu.yml)에서 **Run workflow**를 한 번 실행합니다. 최신 식단표가 Discord에 도착하고 **Save delivery history**가 성공했는지 확인합니다. 이후 예약 실행이 계속됩니다.

이 폴더를 비어 있는 저장소에 처음 올릴 때는 아래 명령을 사용할 수 있습니다. 이미 업로드된 저장소에서는 다시 실행할 필요가 없습니다.

```powershell
git init -b main
git add .
git commit -m "Add weekly menu Discord notifier"
git remote add origin https://github.com/oyushik/weekly-menu-manhwa.git
git push -u origin main
```

## 로컬 확인

Node.js 24 이상에서 실행합니다. Windows PowerShell이 `npm.ps1` 실행을 막으면 `npm` 대신 `npm.cmd`를 쓰면 됩니다.

```powershell
npm ci --ignore-scripts
npm test
npm run preview
```

`preview`는 현재 최신 글과 실제 이미지 다운로드를 확인합니다. 웹훅 없이 실행되며 Discord에 보내거나 전송 기록을 바꾸지 않습니다.

실제 로컬 전송은 `.env.example`을 `.env`로 복사하고 웹훅 URL을 채운 뒤 `npm start`를 실행합니다. 한 번 확인하고 종료하며 기록은 `data/state.json`에 저장됩니다. `STATE_FILE` 환경 변수로 기록 파일 위치를 바꿀 수 있습니다. GitHub와 로컬의 기록은 별개이므로 둘을 동시에 실제 전송에 사용하면 중복될 수 있습니다.

## 운영 시 알아둘 점

- GitHub 예약 실행은 혼잡할 때 지연되거나 누락될 수 있어 정확히 15분 이내 도착을 보장하지는 않습니다. 공개 저장소는 60일 동안 활동이 없으면 예약 실행이 비활성화될 수 있습니다. [GitHub 예약 실행 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- 매일 96회 실행됩니다. 비공개 저장소는 계정의 Actions 사용량을 확인하세요. 주기는 워크플로의 `cron`으로 변경할 수 있습니다. 시간당 한 번이면 `'7 * * * *'`입니다.
- Discord의 전송 확인을 받은 뒤 기록합니다. 전송은 성공했지만 응답이 끊기거나 GitHub 기록 저장이 실패한 경우, 다음 실행에서 일부 이미지가 중복될 수 있습니다. 외부 두 서비스 사이의 완전한 1회 전송은 보장하지 않습니다. **Save delivery history** 실패는 먼저 해결하세요.
- 개별 이미지가 10 MiB를 넘거나 지원하지 않는 형식이면 오류로 남깁니다. 한 메시지에 모을 이미지는 최대 10장, 파일 크기 합계는 최대 24 MiB로 제한합니다. 한도를 넘으면 일부만 보내지 않고 오류로 남깁니다. 현재 확인한 식단표 이미지 2장은 각각 약 108 KB, 73 KB입니다. 탐색 한도는 100페이지이며 한도에 도달하면 조용히 누락하는 대신 실패합니다.
- `bot-state` 브랜치를 삭제하면 처음 실행으로 취급하여 최신 글을 다시 보냅니다. 전송 기록을 보존하세요. 웹훅 채널을 바꿔도 기록은 유지됩니다.
- 실패 원인은 Actions의 실행 로그에서 확인합니다. `HTTP 401/403/404`가 Discord 전송에서 나면 웹훅 URL과 권한을 확인하고, 게시판 조회에서 나면 사이트 접근 상태를 확인합니다. `429` 응답은 Discord가 지정한 시간만큼 기다렸다가 재시도합니다. [Discord 웹훅 API](https://docs.discord.com/developers/resources/webhook#execute-webhook)
