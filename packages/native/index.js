const { existsSync } = require("node:fs");
const { join } = require("node:path");

const triples = {
	"linux-x64-gnu": "signet-native.linux-x64-gnu.node",
	"linux-x64-musl": "signet-native.linux-x64-musl.node",
	"linux-arm64-gnu": "signet-native.linux-arm64-gnu.node",
	"linux-arm64-musl": "signet-native.linux-arm64-musl.node",
	"darwin-x64": "signet-native.darwin-x64.node",
	"darwin-arm64": "signet-native.darwin-arm64.node",
	"win32-x64": "signet-native.win32-x64-msvc.node",
	"win32-arm64": "signet-native.win32-arm64-msvc.node",
};

function loadBinding() {
	const { platform, arch } = process;
	let key;
	if (platform === "linux") {
		const isMusl =
			existsSync("/etc/alpine-release") ||
			existsSync("/lib/ld-musl-x86_64.so.1") ||
			existsSync("/lib/ld-musl-aarch64.so.1");
		const libc = isMusl ? "musl" : "gnu";
		key = `${platform}-${arch}-${libc}`;
	} else {
		key = `${platform}-${arch}`;
	}
	const file = triples[key];
	if (!file) {
		throw new Error(`Unsupported platform: ${key}`);
	}
	const bindingPath = join(__dirname, file);
	if (!existsSync(bindingPath)) {
		throw new Error(`Native binding not found: ${bindingPath}`);
	}
	return require(bindingPath);
}

module.exports = loadBinding();
