
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

import { opt } from './lib/config.js';
import { setLogger, debug, _ } from './lib/log.js';
import { Desktop } from './lib/desktop.js';
import { Session } from './lib/session.js';

/* ToDo:
    self_managed: LibreOffice (sometimes?)
    Save settings in the session.ini file so that they can be modified there
    Offer auto-save on window create/move/resize/close and auto-restore on GNOME startup

    journalctl -f GNOME_SHELL_EXTENSION_UUID=session@research-lab.ca -q --output=json --all | jq --unbuffered -r '"\(.["__REALTIME_TIMESTAMP"] | tonumber / 1000000 | todateiso8601 | sub("Z$"; "")): \(.MESSAGE)"' | tee journalctl

    Impress opening dialog blocks all other LibreOffice launches! (sometimes?)
        Nautilus dialog does not block other launches.
*/

const SessionToggle = GObject.registerClass(
class SessionToggle extends QuickMenuToggle {
    _init() {
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
                let session = new Desktop();
                session.save();
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
                    let session = new Session();
                    session.match_by_id();
                    if (level>0) session.match_by_properties();
                    if (level>1) session.restore_missing();
                    if (level<2) session.restore_properties();
                } catch(error) {
                    debug(0, error);
                }
            });
            this.menu.addMenuItem(item);
        }

        this.connect('clicked', () => this.menu.open());
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init() {
        super._init();

        this._toggle = new SessionToggle();
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
        setLogger({
            level: () => opt.debug,
            notify: Main.notify,
            gettext: this.gettext.bind(this),
        });

        this._indicator = new Indicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
