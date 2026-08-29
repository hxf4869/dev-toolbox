.PHONY: install check test build init-dev up down logs migrate init-owner reset-auth reset-dev api-test m1-integration-test web-test worker-test

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

reset-dev:
	CONFIRM_RESET=dev-toolbox ./deploy/scripts/reset-dev.sh

api-test:
	docker run --rm -v "$(CURDIR):/repo" -w /repo/apps/api golang:1.27.0-alpine3.23 sh -c 'go test ./...'

m1-integration-test: init-dev
	docker compose --env-file deploy/.env -f deploy/compose.yaml build api
	./deploy/scripts/test-m1-integration.sh

web-test:
	pnpm --filter @dev-toolbox/web test

worker-test:
	pnpm --filter @dev-toolbox/ai-worker test
