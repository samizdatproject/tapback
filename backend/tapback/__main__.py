import sys

USAGE = "usage: python -m tapback {login|gate} [options]"


def main() -> None:
    cmd, rest = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if cmd == "login":
        from .login import main as run

        run()
    elif cmd == "gate":
        from .gate import main as run

        run(rest)
    else:
        raise SystemExit(USAGE)


main()
