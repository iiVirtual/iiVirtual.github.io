#!/usr/bin/env python3
"""Build true single-file hypertrophy-all-in-one.html (inline CSS, JSON, JS). Run: python3 build-standalone.py"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    css = (ROOT / "styles.css").read_text()
    prog = (ROOT / "bundled_program.json").read_text()
    js = (ROOT / "app-standalone.js").read_text()

    html = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0c0c0e" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <title>Hypertrophy</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2316161a'/%3E%3Cpath fill='%23ea580c' d='M8 20h3v-6h4v6h5v-6h4v6h3v4H8v-4z'/%3E%3C/svg%3E" />
    <style>
{css}
    </style>
  </head>
  <body>
    <script type="application/json" id="program-embed">
{prog}
    </script>
    <div id="app"></div>
    <script>
{js}
    </script>
  </body>
</html>
"""

    out = ROOT / "hypertrophy-all-in-one.html"
    out.write_text(html)
    print(f"Wrote {out} ({len(html)} bytes)")


if __name__ == "__main__":
    main()
