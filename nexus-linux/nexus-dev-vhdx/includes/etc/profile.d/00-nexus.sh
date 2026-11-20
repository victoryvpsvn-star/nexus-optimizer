# NEXUS: banner nexfetch chi tren console cuc bo (tty1/ttyS0) — session SSH (pts/*) tinh sac
case "$(tty 2>/dev/null)" in
    /dev/tty[0-9]*|/dev/ttyS[0-9]*) [ -x /usr/bin/nexfetch ] && /usr/bin/nexfetch ;;
esac
