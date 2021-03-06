const meriyah = require('meriyah');
const MagicString = require('magic-string');

// This class makes it possible to load modules from the 'server'
// snowpack server, for the sake of SSR
module.exports = class SnowpackLoader {
	constructor({loadByUrl}) {
		this.loadByUrl = loadByUrl;
		this.cache = new Map();
	}

	async load(url) {
		if (url.endsWith('.css.proxy.js')) {
			// bit of a hack, but we need to squelch these as they
			// assume we're in the DOM
			return null;
		}

		let data;

		try {
			( data = await this.loadByUrl(url, {isSSR: true}));
		} catch (err) {
			console.error('>>> error fetching ', url);
			throw err;
		}

		const cached = this.cache.get(url);
		const hash = get_hash(data);

		if (cached && cached.hash === hash) {
			return cached.exports;
		}

		const code = new MagicString(data);
		let ast;

		try {
			ast = meriyah.parseModule(data, {
				ranges: true
			});
		} catch (err) {
			console.error('>>> error parsing ', url);
			console.log(data);
			throw err;
		}

		const imports = [];

		const export_from_identifiers = new Map();
		let uid = 1;

		ast.body.forEach(node => {
			if (node.type === 'ImportDeclaration') {
				imports.push(node);
				code.remove(node.start, node.end);
			}

			if (node.type === 'ExportAllDeclaration') {
				if (!export_from_identifiers.has(node.source)) {
					export_from_identifiers.set(node.source, `__import${uid++}`);
				}

				code.overwrite(node.start, node.end, `Object.assign(exports, ${export_from_identifiers.get(node.source)})`)
				imports.push(node);
			}

			if (node.type === 'ExportDefaultDeclaration') {
				code.overwrite(node.start, node.declaration.start, 'exports.default = ');
			}

			if (node.type === 'ExportNamedDeclaration') {
				if (node.source) {
					imports.push(node);

					if (!export_from_identifiers.has(node.source)) {
						export_from_identifiers.set(node.source, `__import${uid++}`);
					}
				}

				if (node.specifiers && node.specifiers.length > 0) {
					code.remove(node.start, node.specifiers[0].start);

					node.specifiers.forEach(specifier => {
						const lhs = `exports.${specifier.exported.name}`;
						const rhs = node.source
							? `${export_from_identifiers.get(node.source)}.${specifier.local.name}`
							: specifier.local.name;

						code.overwrite(specifier.start, specifier.end, `${lhs} = ${rhs}`)
					});

					code.remove(node.specifiers[node.specifiers.length - 1].end, node.end);
				}

				else {
					throw new Error(`TODO ${url}`);
				}
			}
		});

		const deps = [];
		imports.forEach(node => {
			const resolved = new URL(node.source.value, `http://localhost${url}`);
			const promise = this.load(resolved.pathname);

			if (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
				// `export * from './other.js'` or `export { foo } from './other.js'`
				deps.push({
					name: export_from_identifiers.get(node.source),
					promise
				});
			}

			else if (node.specifiers.length === 0) {
				// bare import
				deps.push({
					name: null,
					promise
				});
			}

			else if (node.specifiers[0].type === 'ImportNamespaceSpecifier') {
				deps.push({
					name: node.specifiers[0].local.name,
					promise
				});
			}

			else {
				deps.push(...node.specifiers.map(specifier => ({
					name: specifier.local.name,
					promise: promise.then(exports => exports[specifier.imported ? specifier.imported.name : 'default'])
				})));
			}
		});

		deps.sort((a, b) => !!a.name !== !!b.name ? a.name ? -1 : 1 : 0);

		code.append(`\n//# sourceURL=${url}`);

		const fn = new Function('exports', ...deps.map(d => d.name).filter(Boolean), code.toString());
		const values = await Promise.all(deps.map(d => d.promise));

		const exports = {};
		fn(exports, ...values);

		this.cache.set(url, { hash, exports });

		// {
		// 	// for debugging
		// 	const { pathname } = new URL(url);
		// 	const file = `.tmp${pathname}`;
		// 	const dir = path.dirname(file);
		// 	try {
		// 		fs.mkdirSync(dir, { recursive: true });
		// 	} catch {}

		// 	fs.writeFileSync(file, code.toString());
		// }

		return exports;
	}
}

function get_hash(str) {
	let hash = 5381;
	let i = str.length;

	while(i) hash = (hash * 33) ^ str.charCodeAt(--i);
	return hash >>> 0;
}