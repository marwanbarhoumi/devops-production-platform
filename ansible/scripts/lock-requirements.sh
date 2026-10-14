#!/bin/sh
# Regenerates requirements.txt (every Python package pinned) from requirements.in.
# Run it in the Dockerfile's base image so the resolution matches the controller image:
#   docker run --rm -v "${PWD}/ansible:/src" -w /src <PYTHON_IMAGE from Dockerfile> sh scripts/lock-requirements.sh
set -eu
pip install --quiet --no-cache-dir --root-user-action=ignore -r requirements.in
{
  echo '# Generated from requirements.in by scripts/lock-requirements.sh. Do not edit by hand.'
  pip freeze --exclude pip --exclude setuptools --exclude wheel
} > requirements.txt
echo "requirements.txt: $(grep -vc '^#' requirements.txt) pinned packages"
