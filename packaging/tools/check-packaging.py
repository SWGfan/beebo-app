#!/usr/bin/env python3
"""Consistency and structure checks for the files under packaging/.

Needs: python 3, PyYAML (pip install pyyaml). jsonschema (pip install jsonschema) is used when
present, together with --online (fetches the winget and Scoop JSON schemas from GitHub).

Run from anywhere:  python packaging/tools/check-packaging.py [--online]
Exit code 0 = everything checked passed; 1 = at least one problem.
"""
import configparser
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
ONLINE = "--online" in sys.argv
problems = []
notes = []


def fail(msg):
    problems.append(msg)
    print("FAIL", msg)


def ok(msg):
    print("ok  ", msg)


def load_yaml(path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        fail(f"{path.relative_to(ROOT)} is not valid YAML: {e}")
        return None


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310 (fixed https URLs)
        return json.loads(r.read().decode("utf-8"))


def schema_check(instance, schema_url, label):
    try:
        import jsonschema
    except ImportError:
        notes.append(f"{label}: jsonschema not installed, schema check skipped")
        return
    try:
        schema = fetch_json(schema_url)
    except Exception as e:  # noqa: BLE001
        notes.append(f"{label}: could not fetch schema ({e}), skipped")
        return
    errs = list(jsonschema.Draft7Validator(schema).iter_errors(instance))
    if errs:
        for e in errs[:5]:
            fail(f"{label}: {e.message}")
    else:
        ok(f"{label} matches its JSON schema")


# ---------------------------------------------------------------- winget
wdir = ROOT / "winget/manifests/b/BeeboEntertainment/Beebo"
versions = [p for p in wdir.iterdir() if p.is_dir()]
winget_sha = set()
winget_version = None
for vdir in versions:
    ver = vdir.name
    files = {
        "version": vdir / "BeeboEntertainment.Beebo.yaml",
        "installer": vdir / "BeeboEntertainment.Beebo.installer.yaml",
        "defaultLocale": vdir / "BeeboEntertainment.Beebo.locale.en-US.yaml",
    }
    for kind, path in files.items():
        if not path.exists():
            fail(f"winget {ver}: missing {path.name}")
            continue
        doc = load_yaml(path)
        if not doc:
            continue
        if doc.get("PackageIdentifier") != "BeeboEntertainment.Beebo":
            fail(f"{path.name}: PackageIdentifier mismatch")
        if str(doc.get("PackageVersion")) != ver:
            fail(f"{path.name}: PackageVersion {doc.get('PackageVersion')} != folder {ver}")
        if doc.get("ManifestType") != kind:
            fail(f"{path.name}: ManifestType {doc.get('ManifestType')} != {kind}")
        if kind == "installer":
            for inst in doc["Installers"]:
                sha = inst["InstallerSha256"]
                if not re.fullmatch(r"[0-9A-F]{64}", sha):
                    fail(f"{path.name}: InstallerSha256 must be 64 upper-case hex characters")
                winget_sha.add(sha.lower())
                if ver not in inst["InstallerUrl"]:
                    fail(f"{path.name}: InstallerUrl does not contain version {ver}")
            if doc.get("InstallerType") != "nullsoft":
                fail(f"{path.name}: InstallerType should be nullsoft")
        if ONLINE:
            schema_check(
                json.loads(json.dumps(doc, default=str)),
                f"https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests/v1.12.0/manifest.{kind}.1.12.0.json",
                f"winget {path.name}",
            )
    winget_version = ver
ok(f"winget manifests parsed ({len(versions)} version folder)")

# ---------------------------------------------------------------- scoop
scoop_path = ROOT / "scoop/bucket/beebo-entertainment.json"
scoop = json.loads(scoop_path.read_text(encoding="utf-8"))
scoop_sha = scoop["architecture"]["64bit"]["hash"].lower()
if scoop["version"] != winget_version:
    fail(f"scoop version {scoop['version']} != winget {winget_version}")
if scoop_sha not in winget_sha:
    fail("scoop hash differs from winget InstallerSha256")
if scoop["version"] not in scoop["architecture"]["64bit"]["url"]:
    fail("scoop url does not contain the version")
if ONLINE:
    schema_check(scoop, "https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json", "scoop manifest")
ok("scoop manifest parsed")

# ------------------------------------------------------------ chocolatey
choco_dir = ROOT / "chocolatey/beebo-entertainment"
nuspec = ET.parse(choco_dir / "beebo-entertainment.nuspec").getroot()
ns = {"n": "http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd"}
md = nuspec.find("n:metadata", ns)
required = ["id", "version", "title", "authors", "projectUrl", "iconUrl", "copyright", "licenseUrl",
            "packageSourceUrl", "tags", "summary", "description", "releaseNotes"]
for tag in required:
    el = md.find(f"n:{tag}", ns)
    if el is None or not (el.text or "").strip():
        fail(f"nuspec: missing or empty <{tag}>")
if md.findtext("n:version", namespaces=ns) != winget_version:
    fail("nuspec version differs from winget version")
desc = md.findtext("n:description", namespaces=ns) or ""
if not 30 <= len(desc) <= 4000:
    fail(f"nuspec description length {len(desc)} outside 30..4000")
install_ps1 = (choco_dir / "tools/chocolateyInstall.ps1").read_text(encoding="utf-8")
m = re.search(r"checksum64\s*=\s*'([0-9a-fA-F]{64})'", install_ps1)
if not m:
    fail("chocolateyInstall.ps1: checksum64 missing")
elif m.group(1).lower() not in winget_sha:
    fail("chocolatey checksum differs from winget InstallerSha256")
if winget_version and f"Beebo-{winget_version}" not in install_ps1:
    fail("chocolateyInstall.ps1 URL does not carry the version tag")
ok("chocolatey package parsed")

# --------------------------------------------------------------- flatpak
fp = ROOT / "flatpak"
manifest = load_yaml(fp / "com.beeboentertainment.Beebo.yml")
meta = ET.parse(fp / "com.beeboentertainment.Beebo.metainfo.xml").getroot()
if manifest and manifest["id"] != meta.findtext("id"):
    fail("flatpak manifest id != metainfo id")
if meta.findtext("launchable") != "com.beeboentertainment.Beebo.desktop":
    fail("metainfo launchable does not match the desktop file name")
if len(meta.findtext("summary") or "") > 35:
    fail("metainfo summary longer than 35 characters (Flathub guideline)")
desktop = configparser.ConfigParser(interpolation=None)
desktop.optionxform = str
desktop.read(fp / "com.beeboentertainment.Beebo.desktop", encoding="utf-8")
if desktop["Desktop Entry"]["Icon"] != manifest["id"]:
    fail("desktop Icon must equal the app id")
if not (fp / "com.beeboentertainment.Beebo.png").exists():
    fail("flatpak icon missing")
placeholder_sha = "0" * 64
for mod in manifest["modules"]:
    for src in mod.get("sources", []):
        if src.get("sha256") == placeholder_sha:
            notes.append("flatpak: deb SHA-256 is still the placeholder (expected until the Linux release exists)")
json.loads((fp / "flathub.json").read_text(encoding="utf-8"))
ok("flatpak files parsed and consistent")

# ------------------------------------------------------------------- aur
aur = ROOT / "aur/beebo-entertainment-bin"
pkgbuild = (aur / "PKGBUILD").read_text(encoding="utf-8")
srcinfo = (aur / ".SRCINFO").read_text(encoding="utf-8")
pv = re.search(r"^pkgver=(\S+)", pkgbuild, re.M).group(1)
if re.search(r"^\s*pkgver = (\S+)", srcinfo, re.M).group(1) != pv:
    fail(".SRCINFO pkgver differs from PKGBUILD")
for dep in re.findall(r"^depends=\((.*?)\)", pkgbuild, re.M | re.S)[0].replace("'", "").split():
    if f"depends = {dep}" not in srcinfo:
        fail(f".SRCINFO lacks depends = {dep}")
if "\r" in pkgbuild or "\r" in srcinfo:
    fail("PKGBUILD/.SRCINFO must use LF line endings")
if "REPLACE_WITH_SHA256" in pkgbuild:
    notes.append("aur: sha256 is still a placeholder (expected until the Linux release exists)")
ok("AUR files consistent")

# ------------------------------------------------------------ snap/unraid/casaos/umbrel/homebrew
snap = load_yaml(ROOT / "snap/snap/snapcraft.yaml")
if snap:
    if snap.get("confinement") != "strict":
        fail("snapcraft confinement should be strict (see snap/README.md)")
    if len(snap.get("summary", "")) > 78:
        fail("snap summary longer than 78 characters")
unraid = ET.parse(ROOT / "unraid/beebo-entertainment.xml").getroot()
for cfg in unraid.findall("Config"):
    for attr in ("Name", "Target", "Default", "Description", "Type", "Display", "Required", "Mask"):
        if attr not in cfg.attrib:
            fail(f"unraid Config {cfg.get('Name')} lacks {attr}")
    if cfg.get("Type") not in ("Port", "Path", "Variable", "Device"):
        fail(f"unraid Config {cfg.get('Name')} has bad Type")
casaos = load_yaml(ROOT / "nas-stores/casaos/Apps/Beebo/docker-compose.yml")
if casaos:
    x = casaos["x-casaos"]
    for k in ("id", "main", "index", "port_map", "icon", "title", "category"):
        if k not in x:
            fail(f"casaos x-casaos lacks {k}")
    if x["main"] not in casaos["services"]:
        fail("casaos x-casaos.main is not a service")
json.loads((ROOT / "nas-stores/casaos/store-config.json").read_text(encoding="utf-8"))
umbrel = load_yaml(ROOT / "nas-stores/umbrel/beebo-entertainment/umbrel-app.yml")
load_yaml(ROOT / "nas-stores/umbrel/beebo-entertainment/docker-compose.yml")
if umbrel and umbrel["port"] != 47811:
    fail("umbrel port should be 47811")
cask = (ROOT / "homebrew/Casks/beebo-entertainment.rb").read_text(encoding="utf-8")
if cask.count("do") < 2 or cask.count("end") < 2 or "DRAFT" not in cask:
    fail("homebrew cask looks malformed or lost its DRAFT marker")
ok("snap, unraid, casaos, umbrel, homebrew files consistent")

print()
for n in notes:
    print("NOTE", n)
print(f"{len(problems)} problem(s)")
sys.exit(1 if problems else 0)
