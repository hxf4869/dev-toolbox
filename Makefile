.PHONY: install check test build init-dev up down logs migrate init-owner reset-auth rebuild-search reset-dev api-test m1-integration-test m2-integration-test m3-integration-test m4-integration-test m5-integration-test v2-integration-test m5-performance-test m5-recovery-test m5-deployment-contract-test web-test worker-test production-init production-init-owner production-reset-auth build-release production-check production-up production-down backup check-backup prune-backups restore check-integrity verify-https publish-release-status release-check

install:
	pnpm install --frozen-lockfile

check:
	pnpm check
	docker run --rm -v "$(CURDIR):/repo" -w /repo/apps/api golang:1.27.0-alpine3.23 sh -c 'go test ./...'

test:
	pnpm test
	docker run --rm -v "$(CURDIR):/repo" -w /repo/apps/api golang:1.27.0-alpine3.23 sh -c 'go test ./...'

build:
	pnpm build
	docker compose --env-file deploy/.env -f deploy/compose.yaml build

init-dev:
	./deploy/scripts/init-dev.sh

up: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build

down:
	docker compose --env-file deploy/.env -f deploy/compose.yaml down

logs:
	docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f

migrate:
	docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm api /app/migrate

init-owner:
	docker compose --env-file deploy/.env -f deploy/compose.yaml exec api /app/dev-toolbox admin init-owner

reset-auth:
	docker compose --env-file deploy/.env -f deploy/compose.yaml exec api /app/dev-toolbox admin reset-auth

rebuild-search:
	docker compose --env-file deploy/.env -f deploy/compose.yaml exec api /app/dev-toolbox maintenance rebuild-search

reset-dev:
	CONFIRM_RESET=dev-toolbox ./deploy/scripts/reset-dev.sh

api-test:
	docker run --rm -v "$(CURDIR):/repo" -w /repo/apps/api golang:1.27.0-alpine3.23 sh -c 'go test ./...'

m1-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m1-integration.sh

m2-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m2-integration.sh

m3-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m3-integration.sh

m4-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m4-integration.sh

m5-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m5-integration.sh

v2-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	GO_TEST_RUN='^TestM3V2JSONAINarrowSynchronousPath$$|^TestV2Aliyun' ./deploy/scripts/test-m3-integration.sh

m5-performance-test: init-dev
	pnpm --filter @dev-toolbox/web build
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m5-performance.sh

m5-recovery-test:
	./deploy/scripts/test-m5-recovery.sh

m5-deployment-contract-test:
	./deploy/scripts/test-production-edge-modes.sh
	./deploy/scripts/test-restic-backends.sh

production-init:
	./deploy/scripts/init-production.sh

build-release:
	./deploy/scripts/build-release.sh

production-check:
	./deploy/scripts/check-deploy.sh

production-up: production-check
	./deploy/scripts/production-compose.sh up -d --wait

production-init-owner:
	./deploy/scripts/production-compose.sh exec api /app/dev-toolbox admin init-owner

production-reset-auth:
	./deploy/scripts/production-compose.sh exec api /app/dev-toolbox admin reset-auth

production-down:
	./deploy/scripts/production-compose.sh down

backup:
	./deploy/scripts/backup.sh

check-backup:
	./deploy/scripts/check-backup-repository.sh

prune-backups:
	./deploy/scripts/prune-backups.sh

restore:
	./deploy/scripts/restore.sh

check-integrity:
	./deploy/scripts/check-integrity.sh

verify-https:
	./deploy/scripts/verify-https.sh

publish-release-status:
	./deploy/scripts/publish-release-status.sh

release-check:
	./deploy/scripts/check-release-readiness.sh

web-test:
	pnpm --filter @dev-toolbox/web test

worker-test:
	pnpm --filter @dev-toolbox/ai-worker test
