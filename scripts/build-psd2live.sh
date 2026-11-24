#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
engine_dir="$project_dir/.local/tools/psd2live"
task_java="${JAVA_HOME:-$project_dir/.local/tools/jdk-21.0.13.0.2+1/Contents/Home}"
task_gradle="${LIVE2D_GRADLE:-$project_dir/.local/tools/gradle-9.6.1/bin/gradle}"
[ "$(git -C "$engine_dir" rev-parse HEAD)" = bfadd8343774d5b6208146060c4fa175d84a0f4f ] || { echo 'PSD2Live revision mismatch' >&2; exit 1; }
[ -x "$task_java/bin/java" ] && [ -x "$task_gradle" ] || { echo 'Verified local JDK/Gradle is missing' >&2; exit 1; }
cd "$engine_dir"
exec env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
  JAVA_HOME="$task_java" "$task_gradle" --no-daemon --max-workers=2 \
  -Dhttp.proxyHost= -Dhttps.proxyHost= -DsocksProxyHost= -Djava.net.useSystemProxies=false \
  '-Dorg.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8 -Djava.net.useSystemProxies=false -Dhttp.proxyHost= -Dhttps.proxyHost= -DsocksProxyHost=' \
  -Ppsd2live.prebuiltRuntime=false writeRunArgs
