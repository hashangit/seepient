# Login shells source /etc/profile, and Debian replaces PATH for non-root users
# before this directory runs. That drops ~/.local/bin even when the supervisor
# put it first. The persistent home is a volume, so /etc/skel/.profile never
# shows up there. Restore the sandbox home bin for every login shell, including
# the agent shell (`bash -lc`).
if [ -n "${HOME:-}" ]; then
  seepients_local_bin="${HOME}/.local/bin"
  case ":${PATH:-}:" in
    *":${seepients_local_bin}:"*) ;;
    *) PATH="${seepients_local_bin}${PATH:+:$PATH}" ;;
  esac
  export PATH
  unset seepients_local_bin
fi
