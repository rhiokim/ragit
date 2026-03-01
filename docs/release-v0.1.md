# RAGit v0.1.0 Release Checklist

## 기능 체크
- [x] init/config/status/doctor
- [x] ingest --all/--since/--files
- [x] hooks install/uninstall/status
- [x] query (markdown/json/both)
- [x] context pack
- [x] migrate from-sqlitevss

## 품질 체크
- [x] 단위 테스트 (doc type / masking / hybrid score)
- [x] 통합 테스트 (ingest --since)
- [ ] E2E 실환경 검증 (수동)

## 배포 체크
- [ ] `pnpm build`
- [ ] `npm publish --access public`
- [ ] 태그 `v0.1.0` 생성
