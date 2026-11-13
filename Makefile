CLUSTER := relay
IMAGE   := relay:local
URL     := http://localhost:8080
METRICS_SERVER_VERSION := v0.8.0

.PHONY: cluster build load metrics-server deploy up redeploy status logs test loadtest validate clean

cluster:
	kind create cluster --config kind-config.yaml

build:
	docker build -t $(IMAGE) app

load:
	kind load docker-image $(IMAGE) --name $(CLUSTER)

# The HPA needs resource metrics. kind does not ship metrics-server, and its
# kubelets use self-signed certs, hence --kubelet-insecure-tls (local only).
metrics-server:
	kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/$(METRICS_SERVER_VERSION)/components.yaml
	kubectl -n kube-system patch deploy metrics-server --type=json \
	  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

deploy:
	kubectl apply -k k8s/
	kubectl -n relay rollout status deploy/postgres --timeout=120s
	kubectl -n relay rollout status deploy/relay --timeout=180s

up: cluster build load metrics-server deploy

# Rebuild and roll the new image. The tag stays `local`, so force a rollout.
redeploy: build load
	kubectl apply -k k8s/
	kubectl -n relay rollout restart deploy/relay
	kubectl -n relay rollout status deploy/relay --timeout=180s

status:
	kubectl -n relay get deploy,pods,svc,hpa,pdb -o wide

logs:
	kubectl -n relay logs -l app=relay --tail=100 --prefix

# Integration tests against a throwaway Postgres.
test:
	docker rm -f relay-testdb >/dev/null 2>&1 || true
	docker run -d --rm --name relay-testdb -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine >/dev/null
	until docker exec relay-testdb pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 1
	cd app && npm ci --no-audit --no-fund && npm test; rc=$$?; docker rm -f relay-testdb >/dev/null; exit $$rc

# Static checks for everything that ships.
validate:
	kubectl kustomize k8s/ >/dev/null
	kubectl kustomize k8s/prod >/dev/null
	cd terraform && terraform init -backend=false -input=false >/dev/null && terraform validate

# make loadtest RPS=400 DURATION=300  (README: launch peak is ~400 req/s)
RPS      ?= 400
DURATION ?= 300
loadtest:
	node tools/load.js --url $(URL) --rps $(RPS) --duration $(DURATION)

clean:
	kind delete cluster --name $(CLUSTER)
