
/* extension.js
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

import GObject from 'gi://GObject';

import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator }
    from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { Extension as BaseExtension }
    from 'resource:///org/gnome/shell/extensions/extension.js';

import { opt, bind_settings, unbind_settings } from './lib/config.js';
import { setLogger, debug, _ } from './lib/log.js';
import { save_session, restore_session, shutdown } from './lib/actions.js';
import { Auto } from './lib/auto.js';

const SessionToggle = GObject.registerClass(
class SessionToggle extends QuickMenuToggle {
    _init(extension) {
        super._init({
            title: _('Session'),
            icon_name: 'view-paged-rtl-symbolic',
            toggle_mode: false,
        });

        this.menu.setHeader('view-paged-rtl-symbolic', _('Session'));

        let item = new PopupMenu.PopupMenuItem(_('Save session'));
        item.connect('activate', () => {
            try {
                debug(2, `Saving session.`);
                save_session();
            } catch(error) {
                debug(0, error);
            }
        });
        this.menu.addMenuItem(item);

        for (let [level, desc] of [[0, 'existing'], [1, 'matching'], [2, 'missing']]) {
            let item = new PopupMenu.PopupMenuItem(_(`Restore ${desc}`));
            item.connect('activate', () => {
                try {
                    debug(2, `Restoring session (${level}).`);
                    restore_session(level);
                } catch(error) {
                    debug(0, error);
                }
            });
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        item = new PopupMenu.PopupMenuItem(_('Preferences'));
        item.connect('activate', () => extension.openPreferences());
        this.menu.addMenuItem(item);

        this.connect('clicked', () => this.menu.open());
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();

        this._toggle = new SessionToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle.destroy();
        super.destroy();
    }
});

// Add a System Menu "Indicator" entry containing a "SessionToggle" menu button:
export default class Extension extends BaseExtension {
    enable() {
        try {
            this._settings = this.getSettings();
            bind_settings(this._settings);
            setLogger({
                level: () => opt.debug,
                notify: Main.notify,
                gettext: this.gettext.bind(this),
            });

            this._auto = new Auto(this._settings);
            this._auto.start();

            this._indicator = new Indicator(this);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } catch (error) {
            this._teardown();
            throw error;
        }
    }

    disable() {
        this._teardown();
    }

    _teardown() {
        this._indicator?.destroy();
        this._indicator = null;
        this._auto?.stop();
        this._auto = null;
        shutdown();
        if (this._settings) unbind_settings();
        this._settings = null;
    }
}
