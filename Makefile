# No separate "frontend" target/service exists on purpose (Frontend Phase 10,
# docs/frontend-deploy.md): the frontend is folded into core's own Fastify instance as a
# static-file plugin, and core/Dockerfile's build now bakes the frontend's real production build
# into core's image. `make up` already brings the whole system up, frontend included — matching
# Phase 0's original "one command, no manual steps" promise for the whole system, not just the
# backend, with zero changes needed here.
COMPOSE := docker compose --env-file infra/.env -f infra/docker-compose.yml

.PHONY: up up-d down logs ps build clean

up: ## Build and start all services in the foreground
	$(COMPOSE) up --build

up-d: ## Build and start all services in the background
	$(COMPOSE) up --build -d

down: ## Stop and remove all services
	$(COMPOSE) down

logs: ## Follow logs from all services
	$(COMPOSE) logs -f

ps: ## List running services
	$(COMPOSE) ps

build: ## Rebuild service images without starting them
	$(COMPOSE) build

clean: ## Stop services and remove volumes (drops the Postgres data volume)
	$(COMPOSE) down -v
