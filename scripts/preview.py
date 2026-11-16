"""Serve the review site and exact demo-photo slots on loopback only."""

import argparse
import hashlib
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
from urllib.parse import unquote, urlsplit


REVIEW = Path(__file__).resolve().parents[1]
SLOT = re.compile(r"<!-- DEMO-PHOTO:([a-z0-9-]+) -->.*?<!-- /DEMO-PHOTO -->", re.S)
ALLOWED = {".html", ".css", ".js", ".mjs", ".webp", ".png", ".jpg", ".svg", ".woff2", ".txt", ".glb", ".bin", ".wasm"}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def safe_file(root, file):
    if file.is_symlink() or any(part.is_symlink() for part in file.parents if part != root.parent):
        raise ValueError("Linked files are not part of the review surface")
    if hasattr(file, "is_junction") and any(part.is_junction() for part in (file, *file.parents)):
        raise ValueError("Junctions are not part of the review surface")
    resolved = file.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve(strict=True)) or not resolved.is_file():
        raise ValueError("File is outside its declared review root")
    return resolved


def make_server(workspace, port=0, media_manifest=None, prefix=""):
    workspace = workspace.resolve(strict=True)
    site = workspace / "site"
    if not site.is_dir() or not (site / "index.html").is_file():
        raise ValueError("The review website is not ready")
    if prefix and not re.fullmatch(r"/[a-z0-9-]+", prefix):
        raise ValueError("Prefix must be one site path segment")
    files = {}
    for file in site.rglob("*"):
        if file.is_file() and file.suffix.lower() in ALLOWED and not any(part.startswith(".") for part in file.relative_to(site).parts):
            safe_file(site, file)
            files[file.relative_to(site).as_posix()] = file

    media = {}
    if media_manifest:
        data = json.loads(safe_file(workspace / ".cache", media_manifest).read_text(encoding="utf-8"))
        for item in data["photos"]:
            identifier = item["id"]
            if not re.fullmatch(r"reader-(?:cover|open)", identifier) or identifier in media or item["localOnly"] is not True:
                raise ValueError("Unexpected local photo identity or permission")
            file = safe_file(workspace / ".cache" / "hybrid-research" / "media", workspace / item["path"])
            if file.suffix != ".webp" or digest(file.read_bytes()) != item["sha256"]:
                raise ValueError("Local photo drift")
            media[identifier] = {**item, "file": file}

    def replace_slot(match):
        identifier = match[1]
        item = media.get(identifier)
        if item is None:
            return match[0]
        return (
            f'<img src="{prefix}/__demo__/{identifier}.webp" '
            f'alt="{html.escape(item["alt"], quote=True)}" '
            f'width="{int(item["width"])}" height="{int(item["height"])}" '
            f'decoding="async" data-local-demo-image="{identifier}">'
        )

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def reply(self, status, body=b"", mime="text/plain; charset=utf-8", location=None, inquiry_page=False):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            delivery = "https://formsubmit.co" if inquiry_page else "'none'"
            self.send_header("Content-Security-Policy", f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src {delivery}; form-action {delivery}; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            if location:
                self.send_header("Location", location)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                self.reply(400, b"Use the exact loopback address.")
                return
            route = urlsplit(self.path)
            decoded = unquote(route.path)
            if "\\" in decoded or "\x00" in decoded or "%" in decoded or ".." in PurePosixPath(decoded).parts:
                self.reply(400, b"Invalid path.")
                return
            if prefix and not decoded.startswith(prefix + "/"):
                if decoded == prefix:
                    self.reply(308, location=prefix + "/")
                else:
                    self.reply(404, b"Not found.")
                return
            relative = decoded[len(prefix):].lstrip("/")
            photo = re.fullmatch(r"__demo__/(reader-(?:cover|open))\.webp", relative)
            if photo:
                item = media.get(photo[1])
                if not item:
                    self.reply(404, b"Not found.")
                    return
                body = safe_file(workspace / ".cache" / "hybrid-research" / "media", item["file"]).read_bytes()
                if digest(body) != item["sha256"]:
                    self.reply(409, b"Demo media changed; restart the verified preview.")
                    return
                self.reply(200, body, "image/webp")
                return
            key = relative + "index.html" if not relative or relative.endswith("/") else relative
            file = files.get(key)
            if file is None:
                if relative + "/index.html" in files:
                    self.reply(308, location=decoded + "/" + ("?" + route.query if route.query else ""))
                else:
                    self.reply(404, b"Not found.")
                return
            body = safe_file(site, file).read_bytes()
            if file.suffix == ".html":
                body = SLOT.sub(replace_slot, body.decode("utf-8")).encode("utf-8")
            mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".woff2": "font/woff2"}.get(file.suffix)
            self.reply(200, body, mime or mimetypes.guess_type(file.name)[0] or "application/octet-stream", inquiry_page=key == "contact/index.html")

        do_HEAD = do_GET

        def do_POST(self):
            self.close_connection = True
            self.reply(405, b"Local review only. Nothing is sent.")

        do_PUT = do_POST
        do_DELETE = do_POST
        do_PATCH = do_POST

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=REVIEW)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--media-manifest", type=Path)
    parser.add_argument("--demo", action="store_true", help="Use this workspace's private photo manifest if available")
    parser.add_argument("--prefix", default="")
    args = parser.parse_args()
    if args.demo and args.media_manifest:
        parser.error("Choose --demo or --media-manifest, not both")
    manifest = args.media_manifest
    if args.demo:
        candidate = args.workspace / ".cache" / "hybrid-control" / "demo-media.json"
        manifest = candidate if candidate.is_file() else None
    server = make_server(args.workspace, args.port, manifest, args.prefix)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}{args.prefix}/", "pid": os.getpid(), "localOnly": True, "demoPhotos": bool(manifest)}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
