FROM golang:1.27.0-alpine3.23 AS build

WORKDIR /src/apps/api
COPY apps/api/go.mod apps/api/go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
RUN GOPROXY="$GOPROXY" go mod download
COPY apps/api ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/server ./cmd/server \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/dev-toolbox ./cmd/dev-toolbox

FROM alpine:3.23.3

ARG APP_VERSION=development
LABEL org.opencontainers.image.title="dev-toolbox-api" \
      org.opencontainers.image.version=$APP_VERSION
ENV APP_VERSION=$APP_VERSION

RUN addgroup -S -g 10001 app && adduser -S -D -H -u 10001 -G app app
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/migrate /app/migrate
COPY --from=build /out/dev-toolbox /app/dev-toolbox
COPY --chown=app:app apps/api/migrations /app/migrations
COPY --chown=app:app docs/contracts /app/contracts
USER app
EXPOSE 8080
CMD ["/app/server"]
