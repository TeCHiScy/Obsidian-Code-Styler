import { normalizePath, parseYaml, requestUrl, request } from "obsidian";
import { extname } from "path";
import CodeStylerPlugin from "src/main";

const LOCAL_PREFIX = "@/";

export interface Ref {
	code: string;
	startLine: number;
	language: string;
	path: string;
	external?: ExtRef;
}

export interface ExtRef {
	id: string;
	content: string;
	metadata: Partial<ExtRefMetadata>;
	params: ExtRefParams;
}

type LineIdentifier = null | string | number | RegExp;

export interface RefParams {
	path: string;
	storePath: string;
	language: string;
	start: LineIdentifier;
	end: LineIdentifier;
	external?: ExtRefParams;
}

export interface ExtRefParams {
	id: string;
	rawUrl: string;
	hostname: string;
	headers: Record<string, string>;
	storePath: string;
}

export interface ExtRefMetadata {
	site: string;
	title: string;
	datetime: string;
	displayUrl: string;
	author: string;
	repository: string;
	path: string;
	refInfo: {
		ref: string;
		type: string;
	};
}

interface ParsedParams {
	filePath?: string;
	file?: string;
	path?: string;
	link?: string;
	language?: string;
	lang?: string;
	start?: string | number;
	end?: string | number;
	headers?: Record<string, string>;
}

function resolveLocalPath(
	path: string,
	sourcePath: string,
	plugin: CodeStylerPlugin
): string {
	path = path.trim();
	if (path.startsWith("[[") && path.endsWith("]]"))
		return (
			plugin.app.metadataCache.getFirstLinkpathDest(
				path.slice(2, -2),
				sourcePath
			)?.path ?? path
		);
	path = path.replace("\\", "/");
	if (path.startsWith(LOCAL_PREFIX)) {
		return path.substring(2);
	}
	if (path.startsWith("./") || /^[^<:"/\\>?|*]/.test(path)) {
		if (!sourcePath && sourcePath != "")
			throw Error(
				"Cannot resolve relative path because the source path is missing"
			);
		return getRelativePath(path, sourcePath.trim());
	}
	if (path.startsWith("/")) {
		throw Error(
			`Path should not start with "/", use "${LOCAL_PREFIX}" to reference a path relative to the vault root folder`
		);
	}
	throw Error("Cannot resolve path");
}

function getRelativePath(path: string, sourcePath: string) {
	if (path.startsWith("./")) {
		path = path.substring(2);
	}
	const vaultDirs = sourcePath.split("/");
	vaultDirs.pop();
	while (path.startsWith("../")) {
		if (vaultDirs.pop() === undefined) {
			throw Error('Path references outside vault, too many "../"s used');
		}
		path = path.substring(3);
	}
	return normalizePath([...vaultDirs, path].join("/"));
}

export function parseRefParams(
	source: string,
	sourcePath: string,
	plugin: CodeStylerPlugin
): RefParams {
	source = source
		.replace(/^([^:]+):(.+)\n/, "$1: $2\n")
		.replace(/(?<!")\[\[(.*?)\]\](?!")/, '"[[$1]]"');

	let params: ParsedParams | string | null = parseYaml(source);
	if ((params as string) === source || params === null) {
		throw Error("YAML Parse Error");
	}

	params = params as ParsedParams;
	const path = params.filePath ?? params.file ?? params.path ?? params.link;
	if (!path || path === "") {
		throw Error("No path specified");
	}

	let storePath = "";
	let extRefParams: ExtRefParams | undefined = undefined;
	const url = new URL(path);
	if (url.protocol === "http:" || url.protocol === "https:") {
		const id = [
			url.hostname,
			...(url.pathname + url.search).split("/"),
		].join("-");
		storePath = plugin.refContentPath(id);
		extRefParams = {
			id: id,
			rawUrl: path,
			hostname: url.hostname,
			headers: params?.headers ?? {},
			storePath: storePath,
		};
	} else {
		storePath = resolveLocalPath(path, sourcePath, plugin);
	}

	return {
		path: path,
		storePath: storePath,
		language: params?.language ?? params?.lang ?? getLanguage(path),
		external: extRefParams,
		end: getLineIdentifier(params.end),
		start: getLineIdentifier(params.start),
	};
}

export async function _fetchExtRef(params: ExtRefParams): Promise<ExtRef> {
	try {
		if (
			params?.headers &&
			(params?.hostname === "github.com" ||
				params?.hostname === "raw.githubusercontent.com")
		) {
			return await fetchGitHubSCM(params);
		}

		const HEADERS = {
			Accept: "application/json",
			"Content-Type": "application/json",
			...params.headers,
		};

		if (params?.hostname === "gitlab.com") {
			params.rawUrl = params.rawUrl
				.split("?")[0]
				.replace(/(?<=gitlab.com\/.*\/.*\/)raw(?=\/)/, "blob");
			const info = (
				await requestUrl({
					url: params.rawUrl,
					method: "GET",
					headers: HEADERS,
				})
			).json;
			return {
				id: params.id,
				params: params,
				content: await request("https://gitlab.com" + info.raw_path),
				metadata: {
					title: info.name,
					datetime: timeStamp(),
					displayUrl: params.rawUrl,
					author:
						params.rawUrl.match(
							/(?<=^https?:\/\/gitlab.com\/).*?(?=\/)/
						)?.[0] ?? "",
					repository:
						params.rawUrl.match(
							/(?<=^https?:\/\/gitlab.com\/.*?\/).*?(?=\/)/
						)?.[0] ?? "",
					path: info.path,
					refInfo: {
						ref: "", //TODO (@mayurankv) Parse from url
						type: "", //TODO (@mayurankv) Parse from url
					},
				},
			};
		} else if (params?.hostname === "bitbucket.org") {
			return {
				id: params.id,
				params: params,
				content: await request(params.rawUrl),
				metadata: {
					datetime: timeStamp(),
				},
			};
		} else if (params?.hostname === "sourceforge.com") {
			return {
				id: params.id,
				params: params,
				content: await request(params.rawUrl),
				metadata: {
					datetime: timeStamp(),
				},
			};
		}
		return {
			id: params.id,
			params: params,
			content: await request(params.rawUrl),
			metadata: {
				datetime: timeStamp(),
			},
		};
	} catch (error) {
		throw Error(`Could not fetch external URL: ${error}`);
	}
}

async function fetchGitHubSCM(params: ExtRefParams): Promise<ExtRef> {
	const host = "https://api.github.com";
	const partial = params.rawUrl.match(
		/^https?:\/\/(?:raw\.)?github(?:usercontent)?\.com\/([^\/]+)\/([^\/]+)\/(?:blob\/|raw\/)?(?:refs\/(?:heads|tags)\/)?([^\/]+)\/(.+)$/
	);
	if (!partial) {
		throw Error("invalid GitHub url");
	}

	const [, owner, repo, ref, path] = partial;
	const HEADERS = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "Obsidian-Code-Styler",
		...params?.headers,
	};

	// https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content
	const content = await requestUrl({
		url: `${host}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
		method: "GET",
		headers: HEADERS,
	}).json;

	// https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#get-a-commit
	const commit = await requestUrl({
		url: `${host}/repos/${owner}/${repo}/commits/${ref}`,
		method: "GET",
		headers: HEADERS,
	}).json;

	return {
		id: params.id,
		params: params,
		content: decodeURIComponent(escape(atob(content.content))),
		metadata: {
			site: "github",
			title: content.name,
			datetime: commit.commit?.author?.date ?? timeStamp(),
			displayUrl: content.html_url,
			author: commit.commit?.author?.name,
			repository: `${repo}`,
			path: content.path,
			refInfo: {
				ref: ref,
				type: "tree",
			},
		},
	};
}

function getLanguage(path: string): string {
	if (path.startsWith("[[") && path.endsWith("]]")) {
		path = path.slice(2, -2);
	}
	return extname(path).slice(1);
}

export function getLineLimits(
	codeContent: string,
	params: RefParams
): { codeSection: string; startLine: number } {
	const lines = codeContent.split("\n");

	let startIndex: number;
	if (params.start === null) {
		startIndex = 0;
	} else if (typeof params.start === "number") {
		startIndex = params.start - 1;
	} else if (
		(params.start as string)?.startsWith("/") &&
		(params.start as string)?.endsWith("/")
	) {
		const startRegex = new RegExp(
			(params.start as string).replace(/^\/(.*)\/$/, "$1")
		);
		startIndex = lines.findIndex((line) => startRegex.test(line));
	} else {
		startIndex = lines.findIndex(
			(line) => line.indexOf(params.start as string) > -1
		);
	}

	let endIndex: number;
	if (params.end === null) {
		endIndex = lines.length - 1;
	} else if (typeof params.end === "number") {
		endIndex = params.end - 1;
	} else if (
		(params.end as string)?.startsWith("/") &&
		(params.end as string)?.endsWith("/")
	) {
		const endRegex = new RegExp(
			(params.end as string).replace(/^\/(.*)\/$/, "$1")
		);
		endIndex = lines.findIndex((line) => endRegex.test(line));
	} else if ((params.end as string)?.startsWith("+"))
		endIndex = startIndex + Number((params.end as string).slice(1));
	else {
		endIndex = lines.findIndex(
			(line) => line.indexOf(params.end as string) > -1
		);
	}

	if (startIndex > endIndex) {
		throw Error("Specified Start line is after the specified End line");
	}
	if (startIndex === -1) {
		throw Error("Start line could not be found");
	}
	if (endIndex === -1) {
		throw Error("End line could not be found");
	}
	return {
		startLine: startIndex + 1,
		codeSection: lines.slice(startIndex, endIndex + 1).join("\n"),
	};
}

function getLineIdentifier(
	lineIdentifier: string | number | undefined
): LineIdentifier {
	if (typeof lineIdentifier === "undefined") {
		return null;
	}
	if (typeof lineIdentifier === "number") {
		return lineIdentifier;
	}
	// Regex
	if (/^\/(.*)\/$/.test(lineIdentifier)) {
		try {
			return new RegExp(lineIdentifier.replace(/^\/(.*)\/$/, "$1"));
		} catch {
			throw Error("Invalid Regular Expression");
		}
	}
	// Plain Text
	if (/".*"/.test(lineIdentifier)) {
		return lineIdentifier.substring(1, lineIdentifier.length - 1);
	}
	// Plain Text
	if (/'.*'/.test(lineIdentifier)) {
		return lineIdentifier.substring(1, lineIdentifier.length - 1);
	}
	// Plain Text //TODO (@mayurankv) Should this be \D+ ??
	if (/\D/.test(lineIdentifier)) {
		return lineIdentifier;
	}
	// Plain Number
	if (/\d+/.test(lineIdentifier)) {
		return parseInt(lineIdentifier);
	}
	return null;
}

export function timeStamp(): string {
	const date = new Date();
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${minute}`;
}
