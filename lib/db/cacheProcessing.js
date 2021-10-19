const cache = new Map();
const {parseMs} = require("../utils");
const {scanFingerprints} = require("./clickhouse");
class CachedReq {
    constructor(hash, query, res, f, r) {
        cache.set(hash, this);
        this.f = [f];
        this.r = [r];
        this.resps = [res];
        this.query = query;
        this.res = {
            writeHead: (status, headers) => {
                cache.delete(hash);
                this.resps.forEach(r => r.res.writeHead(status, headers))
            },
            write: (chunk) => {
                this.resps.forEach(r => r.res.write(chunk));
            },
            end: () => {
                this.resps.forEach(r => r.res.end());
            }
        }

    }
    async run() {
        try {
            await scanFingerprints(this.query, this);
            this.f.forEach(f => f());
        } catch (e) {
            this.r.forEach(r => r(e));
        }
    }
    add(res,f,r) {
        this.resps.push(res);
        this.f.push(f);
        this.r.push(r);
    }
}

/**
 *
 * @param request {{query: string, limit: number, direction: string, start: string, end: string, step: string}}
 * @param res {any}
 */
module.exports.cachedResp = (request, res) => {
    const req = request.query;
    let start = parseMs(request.start, Date.now() - 3600 * 1000);
    let end = parseMs(request.end, Date.now());
    let step = request.step ? parseInt(request.step) * 1000 : 0;
    let limit = request.limit;
    const hash = `${req}_${Math.floor(start / 100)}_${Math.floor(end / 100)}_${step}_${limit}_${request.direction}`;
    if (cache.has(hash)) {
        return new Promise((f,r) => {
            cache.get(hash).add(res,f,r);
        });
    }
    return new Promise((f,r) => {
        const req = new CachedReq(hash, request, res,f,r);
        req.run();
    });

}