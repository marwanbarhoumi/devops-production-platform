#!/bin/sh
# Prepares SSH for the ansible user, then runs the given command.
#
# Files bind-mounted from Windows show up with 0777 permissions, which OpenSSH rejects for private keys.
# Private keys from /ansible/.ssh (git-ignored) are therefore copied into ~/.ssh, a tmpfs that lives only
# as long as this container, with owner-only permissions. Nothing is written back to the host.
set -eu

ssh_dir="${HOME}/.ssh"
mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"
if [ -d /ansible/.ssh ]; then
  for key in /ansible/.ssh/id_* /ansible/.ssh/*.key; do
    [ -f "$key" ] || continue
    case "$key" in *.pub) continue ;; esac
    install -m 600 "$key" "$ssh_dir/$(basename "$key")"
  done
fi

exec "$@"
