import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { StorageError } from "./errors.js";

const CACHE_FOLDER = "_viewer-cache";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // Graph's limit for a single PUT
const CHUNK = 320 * 1024 * 30; // upload-session chunks must be multiples of 320 KiB
const SELECT = "id,name,size,file,folder,lastModifiedDateTime,lastModifiedBy,cTag,parentReference";

// Stores project files in SharePoint through Microsoft Graph, using an app-only identity that has been granted
// access to specific folders only (Files.SelectedOperations.Selected). Each project is one SharePoint folder
// (drive id + folder item id). Converted IFC models live in a "_viewer-cache" subfolder of that folder.
export function createGraphBackend({ tenantId, clientId, clientSecret, graphBase, loginBase }) {
  const GRAPH = (graphBase || "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
  const LOGIN = (loginBase || "https://login.microsoftonline.com").replace(/\/$/, "");
  let token = null;
  let tokenExpires = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpires - 60_000) return token;
    const res = await fetch(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      console.error("SharePoint sign-in failed:", res.status, (await res.text()).slice(0, 300));
      throw new StorageError("unavailable", "Could not sign in to SharePoint.");
    }
    const data = await res.json();
    token = data.access_token;
    tokenExpires = Date.now() + (data.expires_in ?? 3600) * 1000;
    return token;
  }

  // fetch with auth; retries on throttling (429/503) and once on 401 with a fresh token
  async function graph(pathOrUrl, { method = "GET", headers = {}, body, json, raw } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : GRAPH + pathOrUrl;
    for (let attempt = 0; ; attempt++) {
      const h = { Authorization: `Bearer ${await getToken()}`, ...headers };
      let payload = body;
      if (json !== undefined) {
        payload = JSON.stringify(json);
        h["Content-Type"] = "application/json";
      }
      const res = await fetch(url, { method, headers: h, body: payload, redirect: "follow" });
      if (res.status === 401 && attempt < 1) {
        token = null;
        await res.arrayBuffer().catch(() => {});
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const wait = Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 20);
        await res.arrayBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (raw) return res;
      if (!res.ok) throw await failure(res);
      if (res.status === 204) return null;
      return res.json();
    }
  }

  async function failure(res) {
    const text = await res.text().catch(() => "");
    let code = "";
    try {
      code = JSON.parse(text)?.error?.code ?? "";
    } catch {}
    if (res.status === 404 || code === "itemNotFound") return new StorageError("missing");
    if (res.status === 409 || code === "nameAlreadyExists") return new StorageError("exists");
    console.error(`SharePoint request failed: ${res.status} ${code}`, text.slice(0, 300));
    return new StorageError("unavailable", `SharePoint returned ${res.status}${code ? ` (${code})` : ""}.`, res.status);
  }

  const seg = (name) => encodeURIComponent(name).replaceAll("'", "%27");
  const itemUrl = (project, id) => `/drives/${encodeURIComponent(project.drive_id)}/items/${encodeURIComponent(id)}`;
  const folderUrl = (project) => itemUrl(project, project.item_id);
  const childUrl = (project, name) => `${folderUrl(project)}:/${seg(name)}:`;
  const cacheChildUrl = (project, name) => `${folderUrl(project)}:/${CACHE_FOLDER}/${seg(name)}:`;

  const toEntry = (it) => ({
    id: it.id,
    name: it.name,
    size: it.size ?? 0,
    modified: it.lastModifiedDateTime,
    modifiedBy: it.lastModifiedBy?.user?.displayName ?? it.lastModifiedBy?.application?.displayName ?? null,
    versionKey: it.cTag || `${it.lastModifiedDateTime}-${it.size}`,
  });

  // Upload a local file or in-memory buffer to `target` (an item URL or a path-based "...:/name:" URL).
  async function upload(target, { size, read }, conflict) {
    if (size <= SIMPLE_UPLOAD_MAX) {
      const data = await read(0, size);
      return graph(`${target}/content?@microsoft.graph.conflictBehavior=${conflict}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
      });
    }
    const session = await graph(`${target}/createUploadSession`, {
      method: "POST",
      json: { item: { "@microsoft.graph.conflictBehavior": conflict } },
    });
    let result = null;
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(start + CHUNK, size);
      const data = await read(start, end);
      const res = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${start}-${end - 1}/${size}` },
        body: data,
      });
      if (!res.ok) {
        await fetch(session.uploadUrl, { method: "DELETE" }).catch(() => {});
        throw await failure(res);
      }
      if (res.status === 200 || res.status === 201) result = await res.json();
      else await res.arrayBuffer().catch(() => {});
    }
    return result;
  }

  async function fileSource(filePath) {
    const { size } = await fsp.stat(filePath);
    return {
      size,
      read: async (start, end) => {
        const handle = await fsp.open(filePath, "r");
        try {
          const buf = Buffer.alloc(end - start);
          await handle.read(buf, 0, end - start, start);
          return buf;
        } finally {
          await handle.close();
        }
      },
    };
  }

  const bufferSource = (buffer) => ({ size: buffer.length, read: async (start, end) => buffer.subarray(start, end) });

  async function ensureCacheFolder(project) {
    try {
      await graph(`${folderUrl(project)}/children`, {
        method: "POST",
        json: { name: CACHE_FOLDER, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
      });
    } catch (err) {
      if (err.code !== "exists") throw err;
    }
  }

  async function asStream(res) {
    if (!res.ok) throw await failure(res);
    return { stream: Readable.fromWeb(res.body), size: Number(res.headers.get("content-length")) || 0 };
  }

  return {
    kind: "sharepoint",

    // Make sure the named sub-folders exist under the ref; returns { name: itemId }.
    async ensureFolders(ref, names) {
      const found = {};
      const scan = async () => {
        let next = `${folderUrl(ref)}/children?$select=id,name,folder&$top=200`;
        while (next) {
          const page = await graph(next);
          for (const it of page.value) if (it.folder) found[it.name] = it.id;
          next = page["@odata.nextLink"];
        }
      };
      await scan();
      for (const name of names) {
        if (found[name]) continue;
        try {
          const made = await graph(`${folderUrl(ref)}/children`, {
            method: "POST",
            json: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
          });
          found[name] = made.id;
        } catch (err) {
          if (err.code !== "exists") throw err;
          await scan();
        }
      }
      return Object.fromEntries(names.map((n) => [n, found[n]]));
    },
    // A small named file directly inside the ref (used for the access register workbook).
    async readNamed(ref, name) {
      const res = await graph(`${childUrl(ref, name)}/content`, { raw: true });
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        return null;
      }
      if (!res.ok) throw await failure(res);
      return Buffer.from(await res.arrayBuffer());
    },
    async writeNamed(ref, name, buffer) {
      await upload(childUrl(ref, name), bufferSource(buffer), "replace");
    },

    // Resolve a folder the app has been granted, from ids or a pasted SharePoint URL.
    async describeFolder({ driveId, itemId, url }) {
      let it;
      if (driveId && itemId) {
        it = await graph(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,folder,parentReference`);
      } else if (url) {
        const encoded = "u!" + Buffer.from(url, "utf8").toString("base64url");
        it = await graph(`/shares/${encoded}/driveItem?$select=id,name,folder,parentReference`);
      } else throw new StorageError("missing");
      if (!it.folder) throw new StorageError("missing", "That is not a folder.");
      return { name: it.name, driveId: it.parentReference?.driveId ?? driveId, itemId: it.id };
    },

    async list(project) {
      const out = [];
      let next = `${folderUrl(project)}/children?$select=${SELECT}&$top=200`;
      while (next) {
        const page = await graph(next);
        for (const it of page.value) if (it.file) out.push(toEntry(it));
        next = page["@odata.nextLink"];
      }
      return out;
    },

    async get(project, id) {
      let it;
      try {
        it = await graph(`${itemUrl(project, id)}?$select=${SELECT}`);
      } catch (err) {
        if (err.code === "missing" || err.status === 403) return null; // not a file we can reach: treat as absent
        throw err;
      }
      // The id must belong to THIS project's folder, never another folder the app can reach.
      if (!it.file || it.parentReference?.id !== project.item_id) return null;
      return toEntry(it);
    },

    async read(project, id, { range } = {}) {
      return asStream(await graph(`${itemUrl(project, id)}/content`, { raw: true, headers: range ? { Range: range } : {} }));
    },

    async create(project, name, tmpPath) {
      return toEntry(await upload(childUrl(project, name), await fileSource(tmpPath), "fail"));
    },
    async replace(project, id, tmpPath) {
      return toEntry(await upload(itemUrl(project, id), await fileSource(tmpPath), "replace"));
    },
    async rename(project, id, newName) {
      return toEntry(
        await graph(`${itemUrl(project, id)}?$select=${SELECT}`, {
          method: "PATCH",
          json: { name: newName, "@microsoft.graph.conflictBehavior": "fail" },
        })
      );
    },
    async remove(project, id) {
      await graph(itemUrl(project, id), { method: "DELETE" }); // goes to the SharePoint recycle bin
    },

    // conversion cache (a subfolder in the same SharePoint folder)
    async cacheList(project) {
      const names = new Set();
      let next = `${childUrl(project, CACHE_FOLDER)}/children?$select=name&$top=500`;
      try {
        while (next) {
          const page = await graph(next);
          for (const it of page.value) names.add(it.name);
          next = page["@odata.nextLink"];
        }
      } catch (err) {
        if (err.code !== "missing") throw err;
      }
      return names;
    },
    async cacheRead(project, name) {
      return asStream(await graph(`${cacheChildUrl(project, name)}/content`, { raw: true }));
    },
    async cacheWrite(project, name, buffer) {
      await ensureCacheFolder(project);
      await upload(cacheChildUrl(project, name), bufferSource(buffer), "replace");
    },
    async cachePurge(project, prefix, keep = []) {
      const names = await this.cacheList(project);
      for (const n of names) {
        if (n.startsWith(prefix) && !keep.includes(n)) await graph(cacheChildUrl(project, n), { method: "DELETE" }).catch(() => {});
      }
    },
  };
}
