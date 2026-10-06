#!/bin/zsh
# Деплой API ОПОРЫ в Yandex Cloud (профиль yc «opora»). Секреты — из локального файла, не из репозитория.
#   ./deploy.sh function   — новая версия функции
#   ./deploy.sh gateway    — обновить спецификацию API Gateway
set -euo pipefail
cd "$(dirname "$0")"
y(){ yc "$@" --profile opora; }
SECRETS=${OPORA_SECRETS:-$HOME/.config/yandex-cloud/keys/opora-secrets.env}
YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135
YDB_DATABASE=/ru-central1/b1giuvtignseggirkf97/etncocpgajv92l4kpps3

deploy_function() {
  [[ -f $SECRETS ]] || { echo "нет файла секретов $SECRETS"; exit 1; }
  y serverless function get opora-api >/dev/null 2>&1 || y serverless function create opora-api --description "API ОПОРЫ" >/dev/null
  local SA; SA=$(y iam service-account get opora-fn --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  local ZIP; ZIP=$(mktemp -t opora-fn).zip
  (cd function && zip -q "$ZIP" index.js db.js notify.js package.json package-lock.json)
  local ENV="YDB_ENDPOINT=$YDB_ENDPOINT,YDB_DATABASE=$YDB_DATABASE"
  while IFS='=' read -r k v; do [[ -n $k ]] && ENV="$ENV,$k=$v"; done < "$SECRETS"
  y serverless function version create --function-name opora-api --runtime nodejs22 --entrypoint index.handler \
    --memory 256m --execution-timeout 15s --service-account-id "$SA" \
    --source-path "$ZIP" --environment "$ENV" --format json | python3 -c "import sys,json;d=json.load(sys.stdin);print('function version', d['id'], d['status'])"
  rm -f "$ZIP"
}

deploy_gateway() {
  local FID GWSA SPEC
  FID=$(y serverless function get opora-api --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  GWSA=$(y iam service-account get opora-gw --format json | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
  SPEC=$(mktemp -t opora-gw).yaml
  sed -e "s/__FUNCTION_ID__/$FID/g" -e "s/__SA_ID__/$GWSA/g" gateway.yaml > "$SPEC"
  if y serverless api-gateway get opora-api >/dev/null 2>&1; then
    y serverless api-gateway update opora-api --spec "$SPEC" >/dev/null
  else
    y serverless api-gateway create opora-api --spec "$SPEC" --description "API ОПОРЫ" >/dev/null
  fi
  rm -f "$SPEC"
  y serverless api-gateway get opora-api --format json | python3 -c "import sys,json;d=json.load(sys.stdin);print('gateway https://'+d['domain'], d['status'])"
}

case "${1:-}" in
  function) deploy_function ;;
  gateway) deploy_gateway ;;
  all) deploy_function; deploy_gateway ;;
  *) echo "usage: $0 function|gateway|all"; exit 1 ;;
esac
