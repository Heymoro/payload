#!/usr/bin/env python3
"""Rebuild the pinned Darwin native backport in a new, bounded directory; never install it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import stat
import subprocess
import tarfile
import time
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
META = json.loads((HERE / 'provenance.json').read_text())
PROBE = '''
pub fn heymoro_native_disconnect_clears_handle() -> bool {
    let db = local::Database::open(":memory:", database::OpenFlags::default()).unwrap();
    let mut conn = local::Connection::connect(&db).unwrap();
    conn.disconnect();
    let cleared = conn.handle().is_null();
    std::mem::forget(conn);
    cleared
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    assert platform.system() == 'Darwin' and platform.machine() == 'arm64'
    assert args.output.is_absolute() and not args.output.exists(), 'Use a new absolute output directory.'
    assert subprocess.check_output(['rustc', '+stable', '--version'], text=True).strip() == 'rustc ' + META['rustc']
    root = args.output
    root.mkdir(mode=0o700)
    started = time.monotonic()
    receipts = []
    for name, source in META['downloads'].items():
        target = root / (name + ('.whl' if name == 'cmake' else '.tgz'))
        with urllib.request.urlopen(source['url'], timeout=60) as response:
            with target.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    assert output.tell() <= 64 * 1024 * 1024, "Unexpected source archive size"
        assert hashlib.sha256(target.read_bytes()).hexdigest() == source['sha256'], name
        destination = root / ('source' if name == 'binding' else name)
        destination.mkdir()
        if name == 'cmake':
            with zipfile.ZipFile(target) as archive:
                archive.extractall(destination)
        else:
            with tarfile.open(target) as archive:
                for member in archive.getmembers():
                    parts = Path(member.name).parts[1:]
                    if not parts:
                        continue
                    assert '..' not in parts
                    member.name = str(Path(*parts))
                    archive.extract(member, destination, filter='data')
    tools = root / 'bin'
    tools.mkdir()
    cmake_bin = root / 'cmake/cmake/data/bin'
    for tool in cmake_bin.iterdir():
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    (tools / 'cmake').symlink_to(cmake_bin / 'cmake')
    (tools / 'cp').write_text('#!/bin/sh\nif [ "$1" = "--no-preserve=mode,ownership" ]; then shift; fi\nexec /bin/cp "$@"\n')
    (tools / 'cp').chmod(0o700)
    env = dict(os.environ, RUSTUP_TOOLCHAIN='stable', CARGO_BUILD_JOBS='2',
               CARGO_TARGET_DIR=str(root / 'target'), MACOSX_DEPLOYMENT_TARGET='13.0',
               PATH=str(tools) + os.pathsep + os.environ['PATH'])
    cargo = root / 'source/Cargo.toml'
    original_cargo = cargo.read_text().replace(
        'git = "https://github.com/tursodatabase/libsql/", rev = "' + META['libsqlCommit'] + '"',
        'path = "../libsql/libsql"')
    cargo.write_text(original_cargo + '\n[[bin]]\nname = "heymoro-native-probe"\npath = "heymoro-native-probe.rs"\n')
    lock = root / 'source/Cargo.lock'
    lock.write_text('\n'.join(line for line in lock.read_text().splitlines()
                              if not line.startswith('source = "git+https://github.com/tursodatabase/libsql/')) + '\n')
    library = root / 'libsql/libsql/src/lib.rs'
    original_library = library.read_text()
    library.write_text(original_library + PROBE)
    (root / 'source/heymoro-native-probe.rs').write_text('fn main() { assert!(libsql::heymoro_native_disconnect_clears_handle(), "disconnect must null the freed SQLite handle before Drop can run again"); }\n')

    def run(*, phase, command):
        with (root / (phase + '.log')).open('w') as log:
            process = subprocess.Popen(command, cwd=root / 'source', env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while process.poll() is None:
                time.sleep(1)
                rows = [row.split() for row in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True).splitlines()]
                family = {process.pid}
                for _ in range(12):
                    family |= {int(pid) for pid, parent, _ in rows if int(parent) in family}
                rss = sum(int(value) for pid, _, value in rows if int(pid) in family)
                disk = int(subprocess.check_output(['du', '-sk', str(root)], text=True).split()[0])
                if time.monotonic() - started > 1200 or rss > 4194304 or disk > 3145728:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait()
                    raise RuntimeError('20 minute / 4 GiB RSS / 3 GiB directory build budget exceeded; evidence retained.')
            receipts.append({'phase': phase, 'exit': process.returncode})
            return process.returncode

    probe_command = ['cargo', '+stable', 'run', '--release', '--locked', '--bin', 'heymoro-native-probe']
    assert run(phase='red', command=probe_command) != 0
    assert 'disconnect must null' in (root / 'red.log').read_text()
    connection = root / 'libsql/libsql/src/local/connection.rs'
    original = connection.read_text()
    old = 'unsafe { libsql_sys::ffi::sqlite3_close_v2(self.raw) };'
    assert original.count(old) == 1
    connection.write_text(original.replace(old, 'unsafe { libsql_sys::ffi::sqlite3_close_v2(self.raw); self.raw = std::ptr::null_mut(); };'))
    assert run(phase='green', command=probe_command) == 0
    library.write_text(original_library)
    cargo.write_text(original_cargo)
    assert run(phase='binding', command=['cargo', '+stable', 'build', '--release', '--locked', '--lib']) == 0
    binary = root / 'target/release/liblibsql_js.dylib'
    subprocess.run(['install_name_tool', '-id', '@rpath/libsql_js.node', str(binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', str(binary)], check=True)
    result = {**META, 'nativeSHA256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'checks': receipts}
    data = binary.read_bytes()
    (root / 'index.node').write_bytes(data)
    (root / 'build-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'binary': str(root / 'index.node'), 'sha256': result['nativeSHA256'], 'checks': receipts}))

if __name__ == '__main__':
    main()
