#!/usr/bin/env bash
set -Eeuo pipefail

actionlint_version=1.7.12
actionlint_sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
temporary_directory=$(mktemp -d)
trap 'rm -rf -- "$temporary_directory"' EXIT
archive="$temporary_directory/actionlint.tar.gz"

curl --fail --silent --show-error --location \
  --output "$archive" \
  "https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/actionlint_${actionlint_version}_linux_amd64.tar.gz"
echo "$actionlint_sha256  $archive" | sha256sum --check
tar --extract --gzip --file "$archive" --directory "$temporary_directory" actionlint
"$temporary_directory/actionlint"

if rg -n --glob '*.yml' --glob '*.yaml' \
  'uses:[[:space:]]+[^[:space:]@]+@(?![0-9a-f]{40}(?:[[:space:]]|$))' \
  .github/workflows --pcre2; then
  echo "Every GitHub Action must be pinned to a full commit SHA" >&2
  exit 1
fi
