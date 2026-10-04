
/* lib/session.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Meta    from 'gi://Meta';
import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
import Shell   from 'gi://Shell';

import { opt } from './config.js';
import { is_self_managed } from './apps.js';
import { Settler } from './settle.js';
import { debug, notify, _ } from './log.js';
import { restore_summary } from './policy.js';
import { levenshtein, hungarian_match } from './match.js';
import { Desktop, normal } from './desktop.js';
import { to_absolute, clamp_to_area, rect_string, rects_equal, monitor_containing, window_mode_plan } from './geometry.js';
import { index_for_connector, monitor_geometry, work_area } from './monitors.js';

const NULL_MATCH = /^NULL#\d+$/;
const LAUNCH_LIST_KEY = /^(?:matched|remaining)$/;

// A Session consists of 2 Desktops: A source (current) and a target (restore)
export class Session {
    constructor({ level = 0 } = {}) {
        this.level = level;
        this.restore = new Desktop('restore').windows;
        this.current = new Desktop('current').windows;

        this.stat = { launches: {}, events: {} };
        this.on_finished = null;
        this.on_settled = null;
        this.on_error = null;

        this.settler = new Settler({ on_idle: () => this._check_settled() });
        this._late = { created: 0, events: new Map(), timer: 0, open: false };
        this._settled = false;
        this._started = false;
        this._destroyed = false;
        this._rematching = false;
        this._waited = false;
        this._watched = new Map();
        this._launched_keys = new Set();
        this._failed = new Set();
        this._unlaunchable = new Set();
    }

    _fail(error) {
        if (this.on_error) {
            this.on_error(error);
        } else {
            debug(1, `Restore failed: ${error.stack ?? error}`);
        }
    }

    _score(restore, current) {
        let score = 0;
        score += Math.floor(levenshtein(restore.title, current.title) * 10);
        if (restore.pid       === current.pid      ) score += 6;
        if (restore.command   === current.command  ) score += 6;
        if (restore.workspace === current.workspace) score += 2;
        if (restore.geometry  === current.geometry ) score += 1;
        return score;
    }

    match_by_id() {
        debug(3, 'Matching by ID...');

        for (let restore of Object.values(this.restore)) {
            restore.match = null;

            let current = this.current[restore.id];
            if (current && restore.class   === current.class &&
                           restore.pid     === current.pid   &&
                           restore.command === current.command) {
                debug(3, `Window exists: ${restore.class} (${restore.id}) pid=${restore.pid}`);
                restore.match = current.id;
                current.match = true;
            }
        }
    }

    match_by_properties() {
        debug(3, 'Matching by properties...');

        // First, score each potential restore<->current match:
        let scores = {};
        for (let restore of Object.values(this.restore)) {
            if (restore.match) continue;
            restore._match = null;

            for (let current of Object.values(this.current)) {
                if (current.match) continue;

                // Potential matches must have the same class:
                if (restore.class !== current.class) continue;
                // and at least 1 of title, command, or pid match:
                let score = this._score(restore, current);

                if (score > 5) {
                    scores[restore.class] = scores[restore.class] || {};
                    scores[restore.class][restore.id] = scores[restore.class][restore.id] || {};
                    scores[restore.class][restore.id][current.id] = score;
                }
            }
        }
        debug(4, `scores = ${JSON.stringify(scores, null, 2)}`);

        // Next, find the best overall restore<->current match set (map):
        for (let group of Object.keys(scores)) {
            debug(3, `Group ${group} (${Object.keys(scores[group]).length} windows)...`);

            let [score, map] = hungarian_match ( scores[group] );
            debug(3, `Best match score = ${score}`);

            // Finally, record the resulting set (map):
            for (let id of Object.keys(map)) {
                if (NULL_MATCH.test(map[id])) continue;

                let restore = this.restore[id];
                let current = this.current[map[id]];
                debug(3, `Window matches: ${restore.class} (${restore.id})`
                       + ` = ${current.class} (${current.id}) pid=${current.pid}`
                       + ` score=${scores[group][restore.id][current.id]}`);
                // Mark as tentative match:
                restore._match = current.id;
            }
        }
    }

    restore_missing() {
        debug(3, `Restoring missing windows...`);

        for (let restore of Object.values(this.restore)) {
            if (!this.stat.launches[restore.group]) {
                this.stat.launches[restore.group] = {
                    id: restore.group,
                    comm: restore.comm,
                    class: restore.class,
                    matched: [],
                    remaining: [],
                    _matched: 0,
                };
            }
            if ( restore.match ) {
                this.stat.launches[restore.group].matched.push(restore);
            } else {
                this.stat.launches[restore.group].remaining.push(restore);
            }
        }

        // The launch processing loop is event-driven:
        this.stat.created = global.display.connect('window-created', (display, window) => {
            debug(4, `Window created`);
            let shown = window.connect('shown', () => {
                try {
                    window.disconnect(shown); // Only handle once
                    delete this.stat.events[shown];
                    if (!this.stat.created) return; // Block obsolete events already in progress
                    if (!normal(window)) return;
                    let id = window.get_stable_sequence();
                    if (this.current[id]) return; // Window already processed before shown...
                    this.current = new Desktop('current').windows;
                    window = this.current[id];
                    debug(3, `Window shown: ${window.class} (${window.id}) pid=${window.pid}`);
                    this.match_by_properties();
                    this._process_launches();
                } catch (error) {
                    this._fail(error);
                }
            });
            this.stat.events[shown] = window;
        });

        this._process_launches();
    }

    _process_launches() {
        let wait = 0;
        debug(4, `launches = ${JSON.stringify(this.stat.launches, (key, value) => LAUNCH_LIST_KEY.test(key) ? value.map(restore => restore.id) : value, 2)}`);
        for (let launch of Object.values(this.stat.launches)) {
            // Count current windows matched:
            let _matched = launch.remaining.filter(restore => restore._match).length;

            if (!launch.remaining.length) {
                launch.pid = '-'; // No launch needed
                delete this.stat.launches[launch.id];
            } else if ( launch.MSPW && _matched < launch.remaining.length ) { // Multiple single-pid windows
                if ( _matched <= launch._matched ) {
                    debug(3, `Launches pending: ${launch.class} (${launch.pid})`
                           + `x${launch.remaining.length - _matched} -> waiting`);
                    wait += launch.remaining.length - _matched;
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> waiting`);
                    wait += launch.remaining.length - _matched;
                }
            } else if ( _matched <= launch._matched ) { // No new matches
                if (!launch.pid) {
                    // Handled later
                } else if ( launch.pid !== '-' ) {
                    debug(3, `Launch pending: ${launch.class} (${launch.pid}) -> waiting`);
                    wait++;
                }
            } else if ( _matched < launch.remaining.length ) { // Some new matches
                if (!launch.pid) {
                    // Handled later
                } else if (launch.pid !== '-') {
                    if (this._self_managed(launch.class)) { // Only launch once per self_managed application
                        debug(3, `Launch self-managed: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> give up`);
                        launch.pid = '-';
                    } else {
                        debug(3, `Launch insufficient: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> try again`);
                        launch.pid = null;
                    }
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> gave up`);
                }
            } else { // All remaining windows matched
                if (!launch.pid) {
                    launch.pid = '-'; // No launch needed
                } else if (launch.pid !== '-') {
                    debug(3, `Launch successful: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                } else {
                    debug(3, `All windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                }

                for (let restore of launch.remaining) {
                    restore.match = restore._match;
                }
                delete this.stat.launches[launch.id];
            }

            let self_managed = this._self_managed(launch.class);
            if (!launch.pid) {
                // Multiple single-pid windows (MSPW): Many applications manage
                // multiple windows using a single process. Thus, if a launched
                // process died while creating a single window that shares its
                // pid with all other windows of its class, then it's probably
                // safe to launch all the remaining windows.
                if ( launch.died && !self_managed && _matched == launch._matched+1 && launch.matched.length + _matched > 1 ) {
                    let pid = null;
                    for (let restore of [...launch.matched, ...launch.remaining]) {
                        let id = restore.match || restore._match;
                        if (!id) continue;
                        if (pid === null) {
                            pid = this.current[id].pid;
                        } else if (pid !== this.current[id].pid) {
                            pid = '-';
                            break;
                        }
                    }
                    if ( pid !== '-' ) {
                        launch.pid = pid;
                        launch.MSPW = true;
                        debug(4, `Multiple single-pid windows: ${launch.class} (${launch.pid})`);
                    }
                }
                delete launch.died;

                // A second instance of a self-managed app (e.g. another JVM) never restores anything:
                let keys = [launch.class.toLowerCase(), launch.comm.join(' ')];
                if (self_managed && (keys.some(key => this._launched_keys.has(key)) ||
                                     Object.values(this.current).some(c => c.class === launch.class))) {
                    debug(3, `Self-managed app already running or launched: ${launch.class} -> not launching`);
                    launch.pid = '-';
                }

                if (launch.pid !== '-' && !launch.comm.length) {
                    debug(3, `No command line: ${launch.class} -> cannot launch`);
                    for (let restore of launch.remaining) this._unlaunchable.add(restore.id);
                    launch.pid = '-';
                }
                if (self_managed && launch.pid !== '-') keys.forEach(key => this._launched_keys.add(key));

                for (let i = 1; launch.pid !== '-' && i <= (!launch.MSPW ? 1 : launch.remaining.length - _matched); i++) {
                    let pid = null;
                    try {
                        pid = GLib.spawn_async(
                            null,
                            launch.comm,
                            null,
                            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                            null
                        )[1];
                    } catch (e) {
                        debug(1, `Launch failed: ${launch.class} ${e.message}`);
                        for (let restore of launch.remaining) this._failed.add(restore.id);
                        launch.pid = '-';
                        delete this.stat.launches[launch.id]; // Launch done
                        break;
                    }
                    if ( !launch.MSPW ) launch.pid = pid;

                    let died = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                        try{
                            delete this.stat.events[died];
                            // Processes that die with status = 0 are probably fine:
                            debug(4, `Process died: ${launch.class} (${pid})`);
                            if (status) {
                                debug(3, `Launch died: ${launch.class} (${launch.pid})`
                                       + ` exit = ${(status >> 8) & 0xff}; signal = ${status & 0x7f} -> give up`);
                                launch.pid = '-';
                            }
                            launch.died = true;
                        } catch (error) {
                            this._fail(error);
                        }
                    });
                    this.stat.events[died] = null;

                    wait++;
                }

                if ( launch.pid !== '-' ) {
                    if ( !launch.MSPW ) {
                        debug(2, `Launched window: ${launch.class} (${launch.pid})`);
                    } else {
                        debug(2, `Launched windows: ${launch.class} (${launch.pid})`
                               + `x${launch.remaining.length - _matched}`);
                    }

                    if (!launch.launched) { // First launch attempt
                        for (let restore of launch.remaining) {
                            restore.pid = launch.pid; // Helps matching
                        }
                        launch.launched = true;
                    }
                }
            }

            if (_matched > launch._matched) launch._matched = _matched;
        }

        debug(3, `${wait} pending launches.`);
        if (wait) {
            let load = Gio.File.new_for_path('/proc/loadavg').load_contents(null)[1];
            load = parseFloat(new TextDecoder().decode(load).split(' ')[0]) || 1.0;
            wait = Math.round(5 + (Math.log(wait)/Math.log(20)) * (25 + 13 * load) + 5 * load);
            debug(4, `Waiting maximum ${wait} more seconds.`);

            this._clear_tired();
            this._waited = true;
            this.stat.tired = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
                this.stat.tired = 0;
                try {
                    debug(3, `Tired of waiting for launches...`);
                    this.current = new Desktop('current').windows;
                    this._finish_restore();
                } catch (error) {
                    this._fail(error);
                }
                return GLib.SOURCE_REMOVE;
            });
        } else { // No pending launches
            this._clear_tired();
            this._finish_restore();
        }
    }

    _clear_tired() {
        if (this.stat.tired) GLib.Source.remove(this.stat.tired);
        this.stat.tired = 0;
    }

    _finish_restore() {
        if (this._destroyed) return;
        this._drop_launch_events();

        // If there were launches, then there was enough time for the user to
        // have opened/closed windows in the interim; rematch:
        if (this._waited) {
            this.match_by_id();
            this.match_by_properties();
        }
        this.restore_properties();
    }

    restore_properties() {
        debug(3, `Restoring window properties...`);

        this._focused = null;
        for (let restore of Object.values(this.restore).sort((a, b) => a.workspace - b.workspace)) {
            restore.match = restore.match || restore._match;
            if (!restore.match) continue;
            let current = this.current[restore.match];

            this._restore_window(restore, current);
        }

        let focused = this._focused;
        if (focused) {
            focused.window.activate(global.get_current_time());

            debug(2, `Focused window: ${focused.class} (${focused.id})`);
        }

        this._notify_summary();
        try {
            this.on_finished?.(this);
        } catch (error) {
            debug(1, `Restore completion handler failed: ${error.stack ?? error}`);
        }
        this._start_settle();
    }

    _notify_summary() {
        let restores = Object.values(this.restore);
        let unmatched = restores.filter(r => !r.match);
        let failed = unmatched.filter(r => this._failed.has(r.id)).length;
        let unlaunchable = unmatched.filter(r => !this._failed.has(r.id) && this._unlaunchable.has(r.id)).length;
        notify(_('Session restore'), restore_summary({
            total: restores.length,
            restored: restores.length - unmatched.length,
            not_found: unmatched.length - failed - unlaunchable,
            failed,
            unlaunchable,
        }));
    }

    _drop_launch_events() {
        if (this.stat.created) global.display.disconnect(this.stat.created);
        this.stat.created = null; // Block obsolete events already in progress
        for (let event of Object.keys(this.stat.events)) {
            if (!this.stat.events[event]) {
                GLib.Source.remove(Number(event));
            } else {
                this.stat.events[event].disconnect(Number(event));
            }
        }
        this.stat.events = {};
    }

    destroy() {
        this._destroyed = true;
        this.settler.destroy();
        this._stop_late();
        this._drop_launch_events();
        this._clear_tired();
        this.on_finished = this.on_settled = this.on_error = null;
    }

    _self_managed(wm_class) {
        let app_id = null;
        let tracker = Shell.WindowTracker.get_default();
        for (let current of Object.values(this.current)) {
            if (current.class !== wm_class) continue;
            app_id = tracker.get_window_app(current.window)?.get_id();
            if (app_id) break;
        }
        return is_self_managed(wm_class, app_id, opt.self_managed);
    }

    // Keeps the restored window in place and, for self-managed apps, re-matches on title changes.
    _watch(restore, current) {
        if (this._destroyed) return;
        this._watched.set(restore.id, current.window);
        let locked = restore.state['maximized-horizontal'] || restore.state['maximized-vertical'] || restore.state.fullscreen;
        this.settler.watch(current, restore, () => {
            let rect = current.window.get_frame_rect();
            current.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            current.geometry = rect_string(current.rect);
            this._apply_geometry(restore, current, true);
        }, {
            target_fn: () => this._target_rect(restore, current.window),
            on_title: this._self_managed(restore.class) ? () => this._rematch_class(restore.class) : null,
            geometry: !locked,
        });
    }

    // Reassigns the windows of one class after titles settled; windows whose assignment changed are re-targeted.
    _rematch_class(wm_class) {
        if (this._rematching || this._destroyed) return;
        let restores = Object.values(this.restore)
            .filter(r => r.class === wm_class)
            .sort((a, b) => a.workspace - b.workspace);
        if (restores.length < 2) return;

        this._rematching = true;
        try {
            let fresh = new Desktop('current').windows;
            let currents = Object.values(fresh).filter(c => c.class === wm_class);

            // Prefer the existing assignment on ties so identical titles do not shuffle windows:
            let scores = {};
            for (let restore of restores) {
                let row = {}, viable = false;
                for (let current of currents) {
                    let score = this._score(restore, current);
                    if (score > 5) {
                        viable = true;
                        row[current.id] = restore.match === current.id ? score + 0.5 : score;
                    } else {
                        row[current.id] = 0;
                    }
                }
                if (viable) scores[restore.id] = row;
            }

            let assigned = {};
            if (Object.keys(scores).length) {
                let [, map] = hungarian_match(scores);
                for (let [rid, cid] of Object.entries(map)) {
                    if (!NULL_MATCH.test(cid) && scores[rid][cid] > 5) assigned[rid] = fresh[cid];
                }
            }

            let after = new Set();
            let changed = [];
            for (let restore of restores) {
                let current = assigned[restore.id] || null;
                if (current) after.add(current.id);
                if ((current?.id ?? null) !== (restore.match || null)) changed.push([restore, current]);
            }
            if (!changed.length) return;

            for (let restore of restores) {
                if (restore.match && !after.has(restore.match)) {
                    this.settler.unwatch(this._watched.get(restore.id));
                    this._watched.delete(restore.id);
                }
            }
            for (let [restore, current] of changed) {
                debug(3, `Rematch: ${restore.class} (${restore.id}) = ${current ? current.id : 'none'} (was ${restore.match})`);
                restore.match = restore._match = current ? current.id : null;
                if (!current) continue;
                this.current[current.id] = current;
                this._restore_window(restore, current);
            }
        } finally {
            this._rematching = false;
        }
    }

    _start_settle() {
        if (this._destroyed || this._started) return;
        this._started = true;

        let unmatched = Object.values(this.restore).filter(r => !r.match);
        if (unmatched.length && (this.level === 2 || unmatched.some(r => this._self_managed(r.class)))) {
            this._late.open = true;
            this._late.created = global.display.connect('window-created', (display, window) => {
                let shown = window.connect('shown', () => {
                    try {
                        window.disconnect(shown);
                        this._late.events.delete(shown);
                        if (this._late.open && normal(window)) this._late_shown(window);
                    } catch (error) {
                        this._fail(error);
                    }
                });
                this._late.events.set(shown, window);
            });
            this._late.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, opt.settle_seconds, () => {
                this._late.timer = 0;
                this._stop_late();
                this._check_settled();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._check_settled();
    }

    _late_shown(window) {
        let id = window.get_stable_sequence();
        if (Object.values(this.restore).some(r => r.match === id)) return;
        let fresh = new Desktop('current').windows;
        let current = fresh[id];
        if (!current) return;

        let best = null, best_score = 5;
        for (let restore of Object.values(this.restore)) {
            if (restore.match || restore.class !== current.class) continue;
            let score = this._score(restore, current);
            if (score > best_score) [best, best_score] = [restore, score];
        }
        if (!best) return;

        debug(3, `Late window: ${current.class} (${id}) = restore ${best.id} score=${best_score}`);
        best.match = best._match = id;
        this.current[id] = current;
        this._restore_window(best, current);

        if (!Object.values(this.restore).some(r => !r.match)) this._stop_late();
    }

    _stop_late() {
        let late = this._late;
        late.open = false;
        if (late.created) global.display.disconnect(late.created);
        late.created = 0;
        for (let [id, window] of late.events) {
            try { window.disconnect(id); } catch (e) { debug(4, `Late window disconnect: ${e.message}`); }
        }
        late.events.clear();
        if (late.timer) GLib.Source.remove(late.timer);
        late.timer = 0;
    }

    _check_settled() {
        if (this._settled || this._destroyed || !this._started) return;
        if (this._late.open || this.settler.active) return;
        this._settled = true;
        this.on_settled?.(this);
    }

    _restore_window(restore, current) {
        this._apply_workspace(restore, current);
        this._apply_simple_states(restore, current);
        this._apply_window_mode(restore, current);
        this._watch(restore, current);
    }

    _apply_workspace(restore, current) {
        if (restore.workspace === current.workspace) return;

        let wsm = global.workspace_manager;
        for (let n = wsm.get_n_workspaces(); n <= restore.workspace; n++) {
            wsm.append_new_workspace(false, null);
        }

        current.window.change_workspace(wsm.get_workspace_by_index(restore.workspace));

        debug(2, `${current.class} (${current.id})`
               + ` - moved workspace from ${current.workspace} => ${restore.workspace}`);
    }

    _apply_simple_states(restore, current) {
        for (let state in restore.state) {
            if (restore.state[state] !== current.state[state]) {
                switch (state) {
                    case 'minimized':
                        restore.state[state] ? current.window.minimize() : current.window.unminimize();
                        break;
                    case 'maximized-horizontal':
                    case 'maximized-vertical':
                    case 'fullscreen':
                        break; // Applied around geometry in _apply_window_mode
                    case 'above':
                        restore.state[state] ? current.window.make_above() : current.window.unmake_above();
                        break;
                    case 'sticky':
                        restore.state[state] ? current.window.stick() : current.window.unstick();
                        break;
                    case 'focused':
                        if (restore.state[state]) this._focused = current;
                        break;
                }

                if (state !== 'focused') {
                    debug(2, `${current.class} (${current.id})`
                           + ` - ${state}: ${current.state[state]} => ${restore.state[state]}`);
                }
            }
        }
    }

    _apply_window_mode(restore, current) {
        let win = current.window;
        let monitor_differs = restore.monitor?.connector !== current.monitor?.connector;
        let { want, have, state_differs, locked, cycle } =
            window_mode_plan(restore.state, current.state, monitor_differs);

        // Geometry is ignored while maximized or fullscreen:
        if (cycle) {
            if (have.fs) win.unmake_fullscreen();
            if (have.h || have.v) win.unmaximize();
            this._apply_geometry(restore, current, true);
        } else if (!locked) {
            this._apply_geometry(restore, current);
        }

        if (cycle || state_differs) {
            if (want.fs) win.make_fullscreen();
            if (want.h && want.v) {
                win.maximize();
            } else if (want.h || want.v) {
                win.set_maximize_flags(want.h ? Meta.MaximizeFlags.HORIZONTAL : Meta.MaximizeFlags.VERTICAL);
            }
        }
    }

    // Current index of the monitor the window was saved on, or -1.
    _target_monitor(restore) {
        return index_for_connector(restore.monitor?.connector);
    }

    // Absolute frame rect the restored window should occupy now.
    _target_rect(restore, window = null) {
        let index = this._target_monitor(restore);
        if (index >= 0 && restore.rel) {
            return clamp_to_area(to_absolute(restore.rel, monitor_geometry(index)),
                                 work_area(window, index));
        }

        let monitors = [];
        for (let i = 0; i < global.display.get_n_monitors(); i++) {
            monitors.push(monitor_geometry(i));
        }
        index = monitor_containing(restore.rect, monitors);
        if (index < 0) index = global.display.get_primary_monitor();
        return clamp_to_area(restore.rect, work_area(window, index));
    }

    // `force` skips the comparison for windows whose frame rect is stale after an unmaximize.
    _apply_geometry(restore, current, force = false) {
        let rect = this._target_rect(restore, current.window);
        if (force || !rects_equal(rect, current.rect)) {
            current.window.move_resize_frame(true,
                rect.x, rect.y, rect.width, rect.height);

            let connector = restore.monitor?.connector;
            let source = this._target_monitor(restore) >= 0 ? `monitor ${connector}` : 'absolute fallback';
            debug(2, `${current.class} (${current.id})`
                   + ` - moved from ${current.geometry} => ${rect_string(rect)} (${source})`);
        }
    }
}
