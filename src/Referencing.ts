import {
	MarkdownPostProcessorContext,
	MarkdownRenderer,
	SectionCache,
} from "obsidian";
import {
	ExtRef,
	ExtRefParams,
	Ref,
	getLineLimits,
	_fetchExtRef,
	parseRefParams,
	ExtRefMetadata,
} from "src/Parsing/ReferenceParsing";
import { REF_CODEBLOCK } from "src/Settings";
import CodeStylerPlugin from "src/main";
import { renderSpecificReadingSection } from "./ReadingView";
import { getFileContentLines } from "./Parsing/CodeblockParsing";

type Cache = Record<string, IdCache>;

interface IdCache {
	sourcePaths: string[];
	extRefParams: ExtRefParams;
}

type ReferenceByFile = Record<string, string[]>;

export async function refCodeblockProcessor(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: CodeStylerPlugin
) {
	const info = ctx.getSectionInfo(el);
	if (info === null) {
		throw Error("Could not retrieve codeblock information");
	}

	const lines = [
		info.text.split("\n")[info.lineStart],
		...source.split("\n"),
	];
	if (lines[lines.length - 1] !== "") {
		lines.push("");
	}
	const ref = await getRef(lines, ctx.sourcePath, plugin);
	MarkdownRenderer.render(plugin.app, ref.code, el, ctx.sourcePath, plugin);
	renderSpecificReadingSection(
		Array.from(el.querySelectorAll("pre:not(.frontmatter)")),
		ctx.sourcePath,
		info,
		plugin
	);
}

export async function getRef(
	lines: string[],
	sourcePath: string,
	plugin: CodeStylerPlugin
): Promise<Ref> {
	try {
		const params = parseRefParams(
			lines.slice(1, -1).join("\n"),
			sourcePath,
			plugin
		);
		let extRef: ExtRef | undefined = undefined;
		if (params.external) {
			extRef = await fetchExtRef(params.external, sourcePath, plugin);
		}

		if (!await plugin.app.vault.adapter.exists(params.storePath)) {
			throw Error(`Local file '${params.storePath}' not exist`);
		}

		const content = (
			await plugin.app.vault.adapter.read(params.storePath)
		).trim();
		const sectionInfo = getLineLimits(content, params);
		return {
			path: params.path,
			language: params.language,
			external: extRef,
			startLine: sectionInfo.startLine,
			code: [
				"```",
				params.language,
				" ",
				lines[0].substring(REF_CODEBLOCK.length).trim(),
				"\n",
				sectionInfo.codeSection,
				"\n",
				"```",
			].join(""),
		};
	} catch (error) {
		return {
			language: "",
			startLine: 1,
			path: "",
			code: `> [!error] ${(error instanceof Error
				? error.message
				: String(error)
			).replace(/\n/g, "\n>")}`,
		};
	}
}

export async function updateExternalReferencedFiles(
	plugin: CodeStylerPlugin,
	sourcePath: string | undefined = undefined
) {
	await cleanExternalReferencedFiles(plugin);
	const cache = await readCache(plugin);
	const refs =
		sourcePath !== undefined
			? await getFileExtRefParams(sourcePath, plugin)
			: Object.values(cache).map(
					(idCache: IdCache) => idCache.extRefParams
			  );
	for (const ref of refs) {
		await updateExtRef(ref, plugin);
		cache[ref.id as string].extRefParams = ref;
	}
	await writeCache(cache, plugin);
	plugin.renderReadingView();
}

export async function cleanExternalReferencedFiles(
	plugin: CodeStylerPlugin
): Promise<void> {
	const cache = await readCache(plugin);
	const refsByFile = cacheToReferencesByFile(cache);
	for (const sourcePath of Object.keys(refsByFile)) {
		const extRefIds = (await getFileExtRefParams(sourcePath, plugin)).map(
			(params: ExtRefParams) => params.id
		);
		refsByFile[sourcePath] = refsByFile[sourcePath].filter((id: string) =>
			extRefIds.includes(id)
		);
	}
	const newCache = refsByFileToCache(refsByFile, cache);
	for (const id of Object.keys(cache)) {
		if (Object.keys(newCache).includes(id)) {
			continue;
		}
		await plugin.delete(plugin.refContentPath(id));
		await plugin.delete(plugin.refMetadataPath(id));
	}
	await writeCache(newCache, plugin);
}

function cacheToReferencesByFile(cache: Cache): ReferenceByFile {
	return Object.keys(cache).reduce((result: ReferenceByFile, id: string) => {
		cache[id].sourcePaths.forEach((sourcePath: string) => {
			if (!result[sourcePath]) result[sourcePath] = [id];
			else result[sourcePath].push(id);
		});
		return result;
	}, {});
}

function refsByFileToCache(refsByFile: ReferenceByFile, cache: Cache): Cache {
	return Object.keys(refsByFile).reduce(
		(newCache: Cache, sourcePath: string) => {
			refsByFile[sourcePath].forEach((id: string) => {
				if (typeof newCache?.[id] === "undefined")
					newCache[id] = {
						sourcePaths: [sourcePath],
						extRefParams: cache[id].extRefParams,
					};
				else if (!newCache[id].sourcePaths.includes(sourcePath))
					newCache[id].sourcePaths.push(sourcePath);
			});
			return newCache;
		},
		{}
	);
}

async function getFileExtRefParams(
	sourcePath: string,
	plugin: CodeStylerPlugin
): Promise<ExtRefParams[]> {
	const lines = await getFileContentLines(sourcePath, plugin);
	if (!lines) {
		throw Error(`File could not be read: ${sourcePath}`);
	}
	const refs = [];
	const sections: SectionCache[] =
		plugin.app.metadataCache.getCache(sourcePath)?.sections ?? [];

	for (const section of sections) {
		if (section.type !== "code") {
			continue;
		}
		const codeblockLines = [
			...lines.slice(
				section.position.start.line,
				section.position.end.line
			),
			"",
		];
		if (
			!codeblockLines[0].includes("```reference") &&
			!codeblockLines[0].includes("~~~reference")
		) {
			continue;
		}
		const params = parseRefParams(
			codeblockLines.slice(1, -1).join("\n"),
			sourcePath,
			plugin
		);
		if (params.external) {
			refs.push(params.external);
		}
	}
	return refs;
}

export async function updateExtRef(
	params: ExtRefParams,
	plugin: CodeStylerPlugin
): Promise<ExtRef> {
	const ref = await _fetchExtRef(params);
	await plugin.update(params.storePath, ref.content, false);
	await plugin.update(plugin.refMetadataPath(params.id), ref.metadata);
	return ref;
}

async function fetchExtRef(
	params: ExtRefParams,
	sourcePath: string,
	plugin: CodeStylerPlugin
): Promise<ExtRef> {
	let ref: ExtRef;
	if (!await plugin.app.vault.adapter.exists(params.storePath)) {
		ref = await updateExtRef(params, plugin);
	} else {
		ref = {
			id: params.id,
			params: params,
			content: await plugin.app.vault.adapter.read(params.storePath),
			metadata: await readExtRefMetadata(params.id, plugin),
		};
	}
	const cache = await readCache(plugin);
	if (!cache[params.id]?.sourcePaths?.includes(sourcePath)) {
		if (!cache?.[params.id]) {
			cache[params.id] = { sourcePaths: [], extRefParams: params };
		}
		cache[params.id].sourcePaths.push(sourcePath);
		await writeCache(cache, plugin);
	}
	return ref;
}

async function readCache(plugin: CodeStylerPlugin): Promise<Cache> {
	try {
		return JSON.parse(
			await plugin.app.vault.adapter.read(plugin.cachePath())
		);
	} catch {
		return {};
	}
}

async function writeCache(cache: Cache, plugin: CodeStylerPlugin) {
	await plugin.update(plugin.cachePath(), cache);
}

async function readExtRefMetadata(
	id: string,
	plugin: CodeStylerPlugin
): Promise<Partial<ExtRefMetadata>> {
	try {
		return JSON.parse(
			await plugin.app.vault.adapter.read(plugin.refMetadataPath(id))
		);
	} catch {
		return {};
	}
}
