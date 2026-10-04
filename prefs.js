/* prefs.js
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

import Adw  from 'gi://Adw';
import Gio  from 'gi://Gio';
import Gtk  from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LEVELS = ['existing', 'matching', 'missing'];

function spin_row(settings, key, title, lower, upper, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: 1, page_increment: 10 }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switch_row(settings, key, title) {
    const row = new Adw.SwitchRow({ title });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function level_row(settings) {
    const row = new Adw.ComboRow({
        title: _('Restore level'),
        subtitle: _('Existing windows only, matching windows, or also launch missing applications'),
        model: Gtk.StringList.new([_('Existing'), _('Matching'), _('Missing')]),
    });
    const sync = () => {
        const index = LEVELS.indexOf(settings.get_string('auto-restore-level'));
        if (index >= 0 && row.selected !== index) row.selected = index;
    };
    sync();
    row.connect('notify::selected', () => settings.set_string('auto-restore-level', LEVELS[row.selected]));
    settings.connect('changed::auto-restore-level', sync);
    return row;
}

function self_managed_group(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Restore'),
        description: _('Self-managed applications restore their own windows and are launched at most once.'),
    });
    group.add(spin_row(settings, 'settle-seconds', _('Settle time (seconds)'), 0, 600,
        _('Auto-save stays paused this long after a restore')));

    const entry = new Adw.EntryRow({ title: _('Add self-managed application'), show_apply_button: true });
    group.add(entry);

    let rows = [];
    const rebuild = () => {
        for (const row of rows) group.remove(row);
        rows = settings.get_strv('self-managed').map(name => {
            const row = new Adw.ActionRow({ title: name });
            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Remove'),
            });
            remove.connect('clicked', () => {
                settings.set_strv('self-managed', settings.get_strv('self-managed').filter(n => n !== name));
            });
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };

    entry.connect('apply', () => {
        const name = entry.text.trim();
        const list = settings.get_strv('self-managed');
        if (name && !list.includes(name)) settings.set_strv('self-managed', [...list, name]);
        entry.text = '';
    });
    settings.connect('changed::self-managed', rebuild);
    rebuild();
    return group;
}

export default class SessionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();

        const save = new Adw.PreferencesGroup({ title: _('Auto-save') });
        save.add(switch_row(settings, 'auto-save', _('Save automatically')));
        save.add(spin_row(settings, 'auto-save-minutes', _('Interval (minutes)'), 1, 120));
        page.add(save);

        const restore = new Adw.PreferencesGroup({ title: _('Auto-restore') });
        restore.add(switch_row(settings, 'auto-restore', _('Restore at login')));
        restore.add(spin_row(settings, 'auto-restore-delay-seconds', _('Delay (seconds)'), 0, 120));
        restore.add(level_row(settings));
        page.add(restore);

        page.add(self_managed_group(settings));

        const advanced = new Adw.PreferencesGroup({ title: _('Advanced') });
        const file = new Adw.EntryRow({ title: _('Session file (empty for default)') });
        settings.bind('session-file', file, 'text', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(file);
        advanced.add(spin_row(settings, 'debug-level', _('Debug level'), 0, 4,
            _('0 errors, 1 warnings, 2 info, 3 detail, 4 debug')));
        page.add(advanced);

        window.add(page);
    }
}
