#!/usr/bin/env bash
# Phase 0 (S3/S7): READ-ONLY facts about the host. Changes nothing. Run as the user that will own the stack.
set -u
echo "== whoami / subuid / subgid"; id; grep "^$(id -un):" /etc/subuid /etc/subgid 2>&1
echo "== uidmap / newuidmap"; command -v newuidmap newgidmap || echo "uidmap NOT installed"
echo "== cgroup v2 controllers (root)"; cat /sys/fs/cgroup/cgroup.controllers
echo "== controllers delegated to this user"; cat "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers" 2>&1
echo "== linger"; loginctl show-user "$(id -un)" 2>&1 | grep -E "Linger|State"
echo "== user namespaces"; sysctl kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns 2>&1
echo "== filesystem of home and /var/lib/docker"; df -T "$HOME" /var/lib/docker 2>&1
echo "== ZFS zram/swap"; swapon --show; zramctl 2>&1 | head -3
echo "== memory"; free -m
echo "== top memory consumers"; ps -eo rss,comm --sort=-rss | head -8
echo "== chrome available for amd64?"; apt-cache policy google-chrome-stable 2>&1 | head -3
echo "== docker rootless extras packaged?"; apt-cache policy docker-ce-rootless-extras 2>&1 | head -3
