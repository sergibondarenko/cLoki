const {getDuration} = require("../common");
const reg = require("./log_range_agg_reg");
const {generic_rate} = reg;
const {hash32WithSeed} = require('farmhash');



module.exports = {
    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    rate: (token, query) => {
        if (query.stream && query.stream.length) {
            return reg.rate_stream(token, query);
        }
        const duration = getDuration(token, query);
        return generic_rate(`toFloat64(count(1)) * 1000 / ${duration}`, token, query);
    },

    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    count_over_time: (token, query) => {
        if (query.stream && query.stream.length) {
            return reg.count_over_time_stream(token, query);
        }
        return generic_rate(`toFloat64(count(1))`, token, query);
    },

    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    bytes_rate: (token, query) => {
        if (query.stream && query.stream.length) {
            return reg.bytes_rate_stream(token, query);
        }
        const duration = getDuration(token, query);
        return generic_rate(`toFloat64(sum(length(string))) * 1000 / ${duration}`, token, query);
    },
    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    bytes_over_time: (token, query) => {
        if (query.stream && query.stream.length) {
            return reg.bytes_over_time_stream(token, query);
        }
        return generic_rate(`toFloat64(sum(length(string)))`, token, query);
    },
    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    absent_over_time: (token, query) => {
        if (query.stream && query.stream.length) {
            return reg.bytes_over_time_stream(token, query);
        }
        const duration = getDuration(token, query);
        const query_data = {...query};
        query_data.select = ['labels', `floor(timestamp_ms / ${duration}) * ${duration} as timestamp_ms`,
            `toFloat64(0) as value`];
        query_data.limit = undefined;
        query_data.group_by = ['labels', `timestamp_ms`];
        query_data.order_by = {
            name: ['labels', "timestamp_ms"],
            order: "asc"
        }
        query_data.matrix = true;
        /**
         *
         * @type {registry_types.Request}
         */
        const query_gaps = {
            select: [
                'a1.labels',
                `toFloat64(${Math.floor(query.ctx.start / duration) * duration} + number * ${duration}) as timestamp_ms`,
                'toFloat64(1) as value' //other than the generic
            ],
            from: `(SELECT DISTINCT labels FROM rate_a) as a1, numbers(${Math.floor((query.ctx.end - query.ctx.start) / duration)}) as a2`,
        };
        return {
            ctx: query.ctx,
            with: {
                rate_a: query_data,
                rate_b: query_gaps,
                rate_c: { requests: [{select: ['*'], from: 'rate_a'}, {select: ['*'], from: 'rate_b'}] }
            },
            select: ['labels', 'timestamp_ms', 'min(value) as value'], // other than the generic
            from: 'rate_c',
            group_by: ['labels', 'timestamp_ms'],
            order_by: {
                name: ['labels', 'timestamp_ms'],
                order: 'asc'
            },
            matrix: true
        };
    },

    /**
     *
     * @param token {Token}
     * @param query {registry_types.Request}
     * @returns {registry_types.Request}
     */
    smooth_rate: (token, query) => {
        query.order_by = {
            name: ['timestamp_ms'],
            order: 'ASC'
        };
        const duration = getDuration(token);
        const step = query.ctx.step;
        let streams = new Map();
        const send = (emit) => {
            for (const stream of streams.values()) {
                for(const val of Object.entries(stream.values)) {
                    emit({labels: stream.labels, value: val[1] / (duration / 1000), timestamp_ms: val[0]});
                }
            }
            streams = new Map();
        }
        query.select = [...query.select.filter(f => !f.endsWith('string')), "'' as string"];
        query.matrix = true;
        query.limit = undefined;
        query.stream = [
            ...(query.stream || []),
            (s) => s.remap((emit, e) => {
                if (!e || !e.labels) {
                    send(emit);
                    emit(e);
                    return;
                }

                const hash = Object.entries(e.labels).reduce(
                    (sum, e) => hash32WithSeed(e[1], hash32WithSeed(e[0], sum)), 0);
                if (!streams.has(hash)) {
                    streams.set(hash, {labels: Object.entries(e.labels), values: {}});
                }
                const stream = streams.get(hash);
                for (let i = 0; i < duration; i+=step) {
                    const stepToInc = Math.ceil((parseInt(e.timestamp_ms) + i)/step)*step;
                    if (stepToInc - parseInt(e.timestamp_ms) > duration) {
                        continue;
                    }
                    stream.values[stepToInc] = stream.values[stepToInc] || 0;
                    stream.values[stepToInc] += 1;
                }
            })
        ];
        return query;
    }
};