#!/bin/sh
# A deliberately simple lint: fail on tabs or trailing whitespace in text files.
bad=$(grep -rnIP '\t|[ ]+$' --exclude-dir=.farol --exclude=lint.sh . || true)
if [ -n "$bad" ]; then
  echo "lint: whitespace problems found"
  echo "$bad"
  exit 1
fi
echo "lint: clean"
