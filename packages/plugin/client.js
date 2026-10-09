/*
 * dsh-mcp-direct — Client half (DSH ModuleLoader bundle).
 *
 * Renders the MCP server manager on the plugin's configuration page
 * (Settings -> Plugins -> dsh-mcp-direct -> row config).
 *
 * Two hard rules shape this file:
 *
 *   1. No Harness Client package is imported. `require` here resolves only the
 *      frozen platform table (react, react/jsx-runtime); a throwing top-level
 *      component blanks the slot entry. Every control is written out locally
 *      and styled with theme tokens, so a renamed token degrades looks but
 *      never breaks rendering.
 *
 *   2. MCP data never enters ctx.tools. All data arrives from this plugin's own
 *      Host bridge over loopback HTTP, which keeps the OOM-crashing
 *      dsh-mcp-client path entirely out of the picture.
 */
window.__ModuleLoader__.load({
    id: 'dsh-mcp-direct',
    factory(require) {
        var React = require('react');
        var h = React.createElement;
        var useState = React.useState;
        var useEffect = React.useEffect;
        var useCallback = React.useCallback;
        var useRef = React.useRef;

        /** Bridge base path, matching the Host half's route prefix. */
        var BRIDGE = '/api/dsh-mcp-direct';

        /** One shared stylesheet id, so HMR cannot stack duplicates. */
        var STYLE_ID = 'dsh-mcp-direct-style';

        /* ------------------------------------------------------------------ *
         * i18n — minimal, with an inline fallback so the panel renders even
         * when the locale service is unavailable.
         * ------------------------------------------------------------------ */

        var ZH = {
            title: 'MCP 服务器',
            navLabel: 'MCP 管理',
            subtitle: '直连 MCP 管理器',
            refresh: '刷新',
            refreshTip: '重新探测所有服务器',
            add: '添加服务器',
            cancel: '取消',
            close: '关闭',
            save: '保存并连接',
            saving: '连接中…',
            test: '测试连接',
            testing: '测试中…',
            tools: '查看工具',
            call: '调用',
            remove: '移除',
            confirmRemove: '确认移除',
            back: '返回列表',
            name: '名称',
            nameHint: '小写字母、数字与连字符，例如 mydb',
            transport: '传输方式',
            url: 'URL',
            urlHint: 'http:// 或 https:// 开头',
            command: '启动命令',
            args: '参数',
            argsHint: '每行一个参数',
            status: '状态',
            toolCount: '工具数',
            endpoint: '端点',
            noServers: '尚未注册任何 MCP 服务器。',
            noServersHint: '点击「添加服务器」注册第一个，或使用命令行 mcp-direct add。',
            addTitle: '添加 MCP 服务器',
            toolsTitle: '工具列表',
            callTitle: '调用工具',
            argsLabel: '参数 JSON',
            run: '执行',
            running: '执行中…',
            result: '结果',
            noResult: '尚无结果。',
            schema: '参数定义',
            required: '必填',
            enumValues: '可选值',
            registryPath: '注册表',
            sdkPath: 'MCP SDK',
            sdkMissing: '未找到 MCP SDK',
            loadFailed: '无法读取服务器列表',
            ok: '正常',
            failed: '失败',
            networkError: '请求失败：',
            requiredField: '此项必填',
            badName: '名称只能包含小写字母、数字和连字符',
            badUrl: 'URL 需以 http:// 或 https:// 开头',
            removeDone: '已移除',
            addDone: '已添加',
            isError: '工具返回了错误',
            advanced: '路径设置（只读）',
        };

        /**
         * Translate a key, preferring the Client locale service when present.
         * @param {string} key
         * @returns {string}
         */
        function t(key) {
            var dict = (ctxRef.current && ctxRef.current.__dict) || ZH;
            return dict[key] !== undefined ? dict[key] : key;
        }

        /** Live plugin context, set in apply(); read by helpers above. */
        var ctxRef = { current: null };

        /* ------------------------------------------------------------------ *
         * Bridge client
         * ------------------------------------------------------------------ */

        /**
         * Call one bridge operation.
         *
         * Both directions are JSON by contract, so the result is never a
         * surprise shape: either {ok:true,value} or {ok:false,code,message}.
         *
         * @param {string} op
         * @param {object} [body]
         * @returns {Promise<{ok: boolean, value?: any, code?: string, message?: string}>}
         */
        function bridge(op, body) {
            return fetch(BRIDGE + '/' + op, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body || {}),
            }).then(function (res) {
                return res.json().catch(function () {
                    return { ok: false, code: 'bad-response', message: 'HTTP ' + res.status };
                });
            }).catch(function (err) {
                return { ok: false, code: 'network', message: t('networkError') + String(err && err.message || err) };
            });
        }

        /* ------------------------------------------------------------------ *
         * Small presentational pieces (no external primitives)
         * ------------------------------------------------------------------ */

        function Spinner() {
            return h('span', { className: 'dshmcp-spin', 'aria-hidden': true });
        }

        /**
         * A status pill. Colour comes only from theme state tokens.
         * @param {{state: 'ok'|'fail'|'idle'|'busy', label: string}} props
         */
        function Pill(props) {
            return h('span', { className: 'dshmcp-pill dshmcp-pill-' + props.state }, props.label);
        }

        /**
         * One labelled field row.
         * @param {{label: string, hint?: string, children: any, required?: boolean}} props
         */
        function Field(props) {
            return h('label', { className: 'dshmcp-field' },
                h('span', { className: 'dshmcp-field-label' },
                    props.label,
                    props.required ? h('span', { className: 'dshmcp-req' }, '*') : null),
                props.children,
                props.hint ? h('span', { className: 'dshmcp-hint' }, props.hint) : null);
        }

        function Button(props) {
            var cls = 'dshmcp-btn' + (props.variant ? ' dshmcp-btn-' + props.variant : '');
            return h('button', {
                type: 'button',
                className: cls,
                onClick: props.onClick,
                disabled: props.disabled,
                title: props.title,
            }, props.busy ? h(Spinner, null) : null, props.children);
        }

        /* ------------------------------------------------------------------ *
         * Schema rendering
         * ------------------------------------------------------------------ */

        /**
         * Build a minimal argument skeleton from a JSON Schema.
         *
         * Pre-filling the editor with required keys makes the common case a
         * two-click operation instead of a blank-page typing exercise.
         *
         * @param {object|null} schema
         * @returns {object}
         */
        function skeleton(schema) {
            var out = {};
            var props = schema && schema.properties;
            if (!props) return out;
            var required = Array.isArray(schema.required) ? schema.required : [];
            Object.keys(props).forEach(function (key) {
                if (required.indexOf(key) === -1) return;
                var spec = props[key] || {};
                if (spec.enum && spec.enum.length > 0) out[key] = spec.enum[0];
                else if (spec.default !== undefined) out[key] = spec.default;
                else if (spec.type === 'boolean') out[key] = false;
                else if (spec.type === 'number' || spec.type === 'integer') out[key] = 0;
                else if (spec.type === 'array') out[key] = [];
                else if (spec.type === 'object') out[key] = {};
                else out[key] = '';
            });
            return out;
        }

        /**
         * Render a JSON Schema's top-level properties as a compact table.
         * @param {{schema: object|null}} props
         */
        function SchemaTable(props) {
            var schema = props.schema;
            var properties = schema && schema.properties;
            if (!properties || Object.keys(properties).length === 0) {
                return h('div', { className: 'dshmcp-hint' }, t('schema') + ': —');
            }
            var required = Array.isArray(schema.required) ? schema.required : [];
            return h('div', { className: 'dshmcp-schema' },
                h('div', { className: 'dshmcp-hint' }, t('schema')),
                h('table', { className: 'dshmcp-table' },
                    h('thead', null, h('tr', null,
                        h('th', null, t('name')),
                        h('th', null, 'type'),
                        h('th', null, t('enumValues')),
                        h('th', null, 'description'))),
                    h('tbody', null, Object.keys(properties).map(function (key) {
                        var spec = properties[key] || {};
                        var enums = Array.isArray(spec.enum) ? spec.enum.join(' | ') : '';
                        return h('tr', { key: key },
                            h('td', null,
                                h('code', null, key),
                                required.indexOf(key) !== -1
                                    ? h('span', { className: 'dshmcp-req' }, ' ' + t('required'))
                                    : null),
                            h('td', null, String(spec.type || '—')),
                            h('td', { className: 'dshmcp-enum' }, enums || '—'),
                            h('td', null, String(spec.description || '')));
                    }))));
        }

        /* ------------------------------------------------------------------ *
         * Views
         * ------------------------------------------------------------------ */

        /**
         * Detail view for one server: tool list, schema, and a call runner.
         * @param {{server: object, onBack: Function, notify: Function}} props
         */
        function ServerDetail(props) {
            var server = props.server;
            var [tools, setTools] = useState(null);
            var [loadError, setLoadError] = useState('');
            var [loading, setLoading] = useState(true);
            var [selected, setSelected] = useState(null);
            var [argsText, setArgsText] = useState('{}');
            var [running, setRunning] = useState(false);
            var [result, setResult] = useState(null);

            useEffect(function () {
                var alive = true;
                setLoading(true);
                bridge('tools', { name: server.name }).then(function (res) {
                    if (!alive) return;
                    setLoading(false);
                    if (res.ok) {
                        setTools(res.value.tools);
                        setLoadError('');
                    } else {
                        setTools([]);
                        setLoadError(res.message || 'failed');
                    }
                });
                return function () { alive = false; };
            }, [server.name]);

            /**
             * Select a tool and seed the argument editor from its schema.
             * @param {object} tool
             */
            function pick(tool) {
                setSelected(tool);
                setArgsText(JSON.stringify(skeleton(tool.inputSchema), null, 2));
                setResult(null);
            }

            function run() {
                if (!selected) return;
                var parsed;
                try {
                    parsed = argsText.trim() === '' ? {} : JSON.parse(argsText);
                } catch (err) {
                    setResult({ ok: false, message: '参数不是合法 JSON: ' + String(err.message) });
                    return;
                }
                setRunning(true);
                setResult(null);
                bridge('call', { name: server.name, tool: selected.name, args: parsed }).then(function (res) {
                    setRunning(false);
                    setResult(res);
                });
            }

            return h('div', { className: 'dshmcp-panel' },
                h('div', { className: 'dshmcp-header' },
                    h(Button, { onClick: props.onBack }, '← ' + t('back')),
                    h('span', { className: 'dshmcp-title' }, server.name),
                    h(Pill, {
                        state: server.ok ? 'ok' : 'fail',
                        label: server.ok ? t('ok') + ' · ' + server.toolCount + ' ' + t('toolCount') : t('failed'),
                    })),
                h('div', { className: 'dshmcp-sub' }, server.transport + ' · ' + server.endpoint),
                loadError ? h('div', { className: 'dshmcp-error' }, loadError) : null,

                h('div', { className: 'dshmcp-cols' },
                    // Left: tool list
                    h('div', { className: 'dshmcp-col dshmcp-col-tools' },
                        h('div', { className: 'dshmcp-col-title' }, t('toolsTitle')),
                        loading
                            ? h('div', { className: 'dshmcp-hint' }, h(Spinner, null), ' ' + t('testing'))
                            : h('ul', { className: 'dshmcp-tool-list' }, (tools || []).map(function (tool) {
                                return h('li', {
                                    key: tool.name,
                                    className: 'dshmcp-tool' + (selected && selected.name === tool.name ? ' is-active' : ''),
                                    onClick: function () { pick(tool); },
                                },
                                    h('code', { className: 'dshmcp-tool-name' }, tool.name),
                                    h('span', { className: 'dshmcp-tool-desc' },
                                        String(tool.description || '').split('\n')[0]));
                            })),
                        (tools && tools.length === 0 && !loading)
                            ? h('div', { className: 'dshmcp-hint' }, '—')
                            : null),

                    // Right: schema + runner
                    h('div', { className: 'dshmcp-col dshmcp-col-detail' },
                        selected
                            ? h('div', null,
                                h('div', { className: 'dshmcp-col-title' },
                                    h('code', null, selected.name),
                                    h('span', { className: 'dshmcp-spacer' }),
                                    h(Button, { variant: 'primary', onClick: run, disabled: running, busy: running },
                                        running ? t('running') : t('run'))),
                                h('div', { className: 'dshmcp-tool-desc' }, selected.description || ''),
                                h(SchemaTable, { schema: selected.inputSchema }),
                                h(Field, { label: t('argsLabel') },
                                    h('textarea', {
                                        className: 'dshmcp-textarea',
                                        rows: 6,
                                        spellCheck: false,
                                        value: argsText,
                                        onChange: function (e) { setArgsText(e.target.value); },
                                    })),
                                h('div', { className: 'dshmcp-col-title' }, t('result')),
                                renderResult(result, t))
                            : h('div', { className: 'dshmcp-hint' }, t('callTitle')))));
        }

        /**
         * Render a call result: highlighted failure, else the flattened blocks.
         * @param {object|null} result
         * @param {Function} tt - translator
         */
        function renderResult(result, tt) {
            if (!result) return h('div', { className: 'dshmcp-hint' }, tt('noResult'));
            if (!result.ok) {
                return h('div', { className: 'dshmcp-error' }, result.message || result.code || 'failed');
            }
            return h('div', null,
                result.value.isError ? h('div', { className: 'dshmcp-error' }, tt('isError')) : null,
                h('pre', { className: 'dshmcp-pre' },
                    (result.value.content || []).map(function (item) { return item.text; }).join('\n') || '—'));
        }

        /**
         * Add-server form.
         * @param {{onDone: Function, onCancel: Function}} props
         */
        function AddForm(props) {
            var [name, setName] = useState('');
            var [transport, setTransport] = useState('streamable-http');
            var [url, setUrl] = useState('');
            var [command, setCommand] = useState('');
            var [argsText, setArgsText] = useState('');
            var [busy, setBusy] = useState(false);
            var [error, setError] = useState('');

            function validate() {
                if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return t('badName');
                if (transport === 'stdio') {
                    if (command.trim() === '') return t('requiredField') + ': ' + t('command');
                } else if (!/^https?:\/\//.test(url.trim())) {
                    return t('badUrl');
                }
                return '';
            }

            function submit() {
                var problem = validate();
                if (problem) { setError(problem); return; }
                setBusy(true);
                setError('');
                var body = transport === 'stdio'
                    ? {
                        name: name,
                        transport: 'stdio',
                        command: command.trim(),
                        args: argsText.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
                    }
                    : { name: name, transport: 'streamable-http', url: url.trim() };
                bridge('add', body).then(function (res) {
                    setBusy(false);
                    if (res.ok) props.onDone(res.value);
                    else setError(res.message || res.code || 'failed');
                });
            }

            return h('div', { className: 'dshmcp-panel' },
                h('div', { className: 'dshmcp-header' },
                    h('span', { className: 'dshmcp-title' }, t('addTitle'))),
                error ? h('div', { className: 'dshmcp-error' }, error) : null,

                h(Field, { label: t('name'), hint: t('nameHint'), required: true },
                    h('input', {
                        className: 'dshmcp-input',
                        value: name,
                        spellCheck: false,
                        placeholder: 'mydb',
                        onChange: function (e) { setName(e.target.value); },
                    })),

                h(Field, { label: t('transport'), required: true },
                    h('select', {
                        className: 'dshmcp-input',
                        value: transport,
                        onChange: function (e) { setTransport(e.target.value); },
                    },
                        h('option', { value: 'streamable-http' }, 'streamable-http'),
                        h('option', { value: 'stdio' }, 'stdio'))),

                transport === 'stdio'
                    ? h('div', null,
                        h(Field, { label: t('command'), required: true },
                            h('input', {
                                className: 'dshmcp-input',
                                value: command,
                                spellCheck: false,
                                onChange: function (e) { setCommand(e.target.value); },
                            })),
                        h(Field, { label: t('args'), hint: t('argsHint') },
                            h('textarea', {
                                className: 'dshmcp-textarea',
                                rows: 3,
                                spellCheck: false,
                                value: argsText,
                                onChange: function (e) { setArgsText(e.target.value); },
                            })))
                    : h(Field, { label: t('url'), hint: t('urlHint'), required: true },
                        h('input', {
                            className: 'dshmcp-input',
                            value: url,
                            spellCheck: false,
                            placeholder: 'http://127.0.0.1:3100/mcp',
                            onChange: function (e) { setUrl(e.target.value); },
                        })),

                h('div', { className: 'dshmcp-actions' },
                    h(Button, { onClick: props.onCancel, disabled: busy }, t('cancel')),
                    h(Button, { variant: 'primary', onClick: submit, disabled: busy, busy: busy },
                        busy ? t('saving') : t('save'))));
        }

        /**
         * Main manager view: server rows plus inline add/remove affordances.
         */
        function Manager() {
            var [state, setState] = useState({ loading: true, error: '', data: null });
            var [adding, setAdding] = useState(false);
            var [detail, setDetail] = useState(null);
            var [pendingRemove, setPendingRemove] = useState(null);
            var [notice, setNotice] = useState('');
            var [testing, setTesting] = useState('');

            var load = useCallback(function () {
                setState(function (prev) { return { loading: true, error: '', data: prev.data }; });
                return bridge('list', {}).then(function (res) {
                    if (res.ok) setState({ loading: false, error: '', data: res.value });
                    else setState(function (prev) { return { loading: false, error: res.message || res.code || 'failed', data: prev.data }; });
                });
            }, []);

            useEffect(function () { load(); }, [load]);

            /**
             * Probe one server on demand, so a slow or dead entry does not
             * block the whole list refresh.
             * @param {object} server
             */
            function testOne(server) {
                setTesting(server.name);
                bridge('tools', { name: server.name }).then(function (res) {
                    setTesting('');
                    setNotice(res.ok
                        ? server.name + ': ' + t('ok') + ' · ' + res.value.tools.length + ' ' + t('toolCount')
                        : server.name + ': ' + (res.message || t('failed')));
                });
            }

            function doRemove(server) {
                bridge('remove', { name: server.name }).then(function (res) {
                    setPendingRemove(null);
                    if (res.ok) {
                        setNotice(t('removeDone') + ': ' + server.name);
                        load();
                    } else {
                        setNotice(server.name + ': ' + (res.message || t('failed')));
                    }
                });
            }

            if (adding) {
                return h(AddForm, {
                    onCancel: function () { setAdding(false); },
                    onDone: function (value) {
                        setAdding(false);
                        setNotice(t('addDone') + ': ' + value.name + ' · ' + value.toolCount + ' ' + t('toolCount'));
                        load();
                    },
                });
            }

            if (detail) {
                return h(ServerDetail, {
                    server: detail,
                    onBack: function () { setDetail(null); load(); },
                });
            }

            var servers = (state.data && state.data.servers) || [];

            return h('div', { className: 'dshmcp-panel' },
                h('div', { className: 'dshmcp-header' },
                    h('span', { className: 'dshmcp-title' }, t('title')),
                    h('span', { className: 'dshmcp-sub-inline' }, t('subtitle')),
                    h('span', { className: 'dshmcp-spacer' }),
                    h(Button, {
                        onClick: function () { setNotice(''); load(); },
                        disabled: state.loading,
                        busy: state.loading,
                        title: t('refreshTip'),
                    }, t('refresh')),
                    h(Button, { variant: 'primary', onClick: function () { setAdding(true); } }, '+ ' + t('add'))),

                state.error ? h('div', { className: 'dshmcp-error' }, t('loadFailed') + ': ' + state.error) : null,
                notice ? h('div', { className: 'dshmcp-notice' }, notice) : null,

                servers.length === 0
                    ? h('div', { className: 'dshmcp-empty' },
                        h('div', null, t('noServers')),
                        h('div', { className: 'dshmcp-hint' }, t('noServersHint')))
                    : h('ul', { className: 'dshmcp-server-list' }, servers.map(function (server) {
                        return h('li', { key: server.name, className: 'dshmcp-server' },
                            h('div', { className: 'dshmcp-server-main' },
                                h('div', { className: 'dshmcp-server-name' },
                                    h('code', null, server.name),
                                    h(Pill, {
                                        state: server.ok ? 'ok' : 'fail',
                                        label: server.ok ? t('ok') : t('failed'),
                                    })),
                                h('div', { className: 'dshmcp-server-meta' },
                                    server.transport,
                                    ' · ',
                                    h('span', { className: 'dshmcp-mono' }, server.endpoint || '—'),
                                    server.ok ? ' · ' + server.toolCount + ' ' + t('toolCount') : '',
                                    server.ok && server.ms !== undefined ? ' · ' + server.ms + 'ms' : '')),
                            server.error
                                ? h('div', { className: 'dshmcp-server-err' }, server.error)
                                : null,
                            h('div', { className: 'dshmcp-server-actions' },
                                h(Button, {
                                    onClick: function () { testOne(server); },
                                    disabled: testing === server.name,
                                    busy: testing === server.name,
                                }, testing === server.name ? t('testing') : t('test')),
                                h(Button, { onClick: function () { setDetail(server); } }, t('tools')),
                                pendingRemove && pendingRemove.name === server.name
                                    ? h(Button, { variant: 'danger', onClick: function () { doRemove(server); } }, t('confirmRemove'))
                                    : h(Button, { onClick: function () { setPendingRemove(server); setNotice(''); } }, t('remove'))));
                    })),

                state.data
                    ? h('div', { className: 'dshmcp-foot' },
                        h('div', null, t('registryPath') + ': ', h('code', { className: 'dshmcp-mono' }, state.data.registryPath)),
                        h('div', null, t('sdkPath') + ': ',
                            h('code', { className: 'dshmcp-mono' }, state.data.sdkDir || t('sdkMissing'))),
                        h('div', null, t('advanced') + ': ',
                            h('code', { className: 'dshmcp-mono' }, (state.data.paths && state.data.paths.binDir) || '—')))
                    : null);
        }

        /* ------------------------------------------------------------------ *
         * Styles — theme tokens only, so light/dark follow the host
         * ------------------------------------------------------------------ */

        var CSS = [
            '.dshmcp-panel{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
            '.dshmcp-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
            '.dshmcp-title{font-size:15px;font-weight:600}',
            '.dshmcp-sub-inline{color:var(--dsw-alias-label-tertiary);font-size:12px}',
            '.dshmcp-sub{color:var(--dsw-alias-label-secondary);font-size:12px;font-family:ui-monospace,Consolas,monospace}',
            '.dshmcp-spacer{flex:1 1 auto}',
            '.dshmcp-btn{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px}',
            '.dshmcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshmcp-btn:disabled{opacity:.55;cursor:default}',
            '.dshmcp-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-text);background:var(--dsw-alias-button-primary-dimmed)}',
            '.dshmcp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
            '.dshmcp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
            '.dshmcp-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid transparent}',
            '.dshmcp-pill-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
            '.dshmcp-pill-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
            '.dshmcp-pill-idle,.dshmcp-pill-busy{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-state-idle-primary)}',
            '.dshmcp-spin{width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);display:inline-block;animation:dshmcp-rot .8s linear infinite}',
            '@keyframes dshmcp-rot{to{transform:rotate(360deg)}}',
            '.dshmcp-server-list,.dshmcp-tool-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
            '.dshmcp-server{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}',
            '.dshmcp-server-main{flex:1 1 260px;min-width:0}',
            '.dshmcp-server-name{display:flex;align-items:center;gap:6px}',
            '.dshmcp-server-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px;word-break:break-all}',
            '.dshmcp-server-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:2px;word-break:break-all}',
            '.dshmcp-server-actions{display:flex;gap:6px;flex-wrap:wrap}',
            '.dshmcp-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
            '.dshmcp-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:6px}',
            '.dshmcp-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}',
            '.dshmcp-error{padding:7px 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}',
            '.dshmcp-notice{padding:7px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}',
            '.dshmcp-field{display:flex;flex-direction:column;gap:3px;margin-bottom:10px}',
            '.dshmcp-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
            '.dshmcp-req{color:var(--dsw-alias-state-error-primary)}',
            '.dshmcp-input,.dshmcp-textarea{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}',
            '.dshmcp-textarea{font-family:ui-monospace,Consolas,monospace;resize:vertical}',
            '.dshmcp-input:focus,.dshmcp-textarea:focus{outline:1px solid var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
            '.dshmcp-actions{display:flex;gap:8px;justify-content:flex-end}',
            '.dshmcp-cols{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}',
            '.dshmcp-col{min-width:0}',
            '.dshmcp-col-tools{flex:0 1 300px;max-height:60vh;overflow:auto}',
            '.dshmcp-col-detail{flex:1 1 340px}',
            '.dshmcp-col-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:8px 0 6px}',
            '.dshmcp-tool{padding:5px 8px;border-radius:6px;cursor:pointer;border:1px solid transparent}',
            '.dshmcp-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dshmcp-tool.is-active{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2)}',
            '.dshmcp-tool-name{font-size:12px}',
            '.dshmcp-tool-desc{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dshmcp-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}',
            '.dshmcp-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
            '.dshmcp-table td{padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;color:var(--dsw-alias-label-secondary)}',
            '.dshmcp-enum{color:var(--dsw-alias-state-business-primary)}',
            '.dshmcp-pre{margin:4px 0 0;padding:8px;border-radius:6px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;font-size:12px;max-height:32vh;overflow:auto;white-space:pre-wrap;word-break:break-word}',
            '.dshmcp-foot{margin-top:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex;flex-direction:column;gap:2px;word-break:break-all}',
        ].join('\n');

        /**
         * Inject the stylesheet once and return its disposer.
         * @returns {Function} cleanup
         */
        function insertStyles() {
            if (document.getElementById(STYLE_ID)) return function () {};
            var el = document.createElement('style');
            el.id = STYLE_ID;
            el.textContent = CSS;
            document.head.appendChild(el);
            return function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            };
        }

        /* ------------------------------------------------------------------ *
         * Registration
         * ------------------------------------------------------------------ */

        /**
         * Client entry point.
         * @param {object} ctx - restricted Client context.
         */
        function apply(ctx) {
            ctxRef.current = ctx;

            // Prefer the host locale dictionary when the slot owner exposes one;
            // otherwise the panel renders from the inline Chinese table above.
            try {
                var locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
                if (locale && typeof locale.bind === 'function') {
                    var dict = locale.bind('dsh-mcp-direct');
                    if (dict && typeof dict === 'object') ctxRef.current.__dict = dict;
                }
            } catch (err) {
                // A missing locale service must never stop the panel rendering.
            }

            ctx.effect(insertStyles, 'dsh-mcp-direct: styles');

            // Primary seat: a first-class section in the Settings panel — the
            // same left rail as 通用设置 / 模型 / 内置插件. On this desktop shell
            // that is where users look; plugins.row.config sits two clicks deep
            // behind a plugin card and proved unreachable on this machine.
            ctx.slots.inject('settings.section', function () {
                return ctx.slots.register({
                    name: 'settings.section',
                    id: 'mcp-direct',
                    order: 65,
                    label: function () { return t('navLabel'); },
                }, function () {
                    return h(Manager, null);
                });
            });

            // Secondary seat (kept for shells that render the Plugins page):
            // the row-config page; key is `<package name>#<patch row id>`.
            ctx.slots.inject('plugins.row.config', function () {
                return ctx.slots.register({
                    name: 'plugins.row.config',
                    key: 'dsh-mcp-direct#mcp-direct',
                }, function (slotProps) {
                    // `summary` renders the collapsed one-line hint on the Plugins
                    // list; anything else renders the full page.
                    if (slotProps && slotProps.view === 'summary') {
                        return t('title') + ' · ' + t('subtitle');
                    }
                    return h(Manager, null);
                });
            });
        }

        return {
            inject: ['slots'],
            apply: apply,
        };
    },
});
