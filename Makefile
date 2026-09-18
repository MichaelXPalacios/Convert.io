.PHONY: plan apply migrate seed dev test typecheck lint fmt check

# Infrastructure. Applied from CI only; these targets are for local inspection.
plan:
	cd terraform && terraform plan

apply:
	cd terraform && terraform apply

# Schema. Forward only: the runner refuses to proceed if an applied migration
# has been edited since it ran.
migrate:
	node --env-file=.env.local db/migrate.mjs

seed:
	node --env-file=.env.local db/seed.mjs

dev:
	pnpm --filter @convertio/edge dev

test:
	pnpm -r --if-present test

typecheck:
	pnpm -r --if-present typecheck

lint:
	pnpm exec eslint .

fmt:
	pnpm exec prettier --write .

# What CI runs on a pull request.
check: typecheck lint test
