#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

biome check --write .
