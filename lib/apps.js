/* lib/apps.js
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

function normalize(name) {
    let n = String(name).toLowerCase().replace(/\.desktop$/, '');
    let snap = /^([^_]+)_\1$/.exec(n);
    return snap ? snap[1] : n;
}

function same_app(a, b) {
    a = normalize(a);
    b = normalize(b);
    if (a === b) return true;
    let a_rdns = a.includes('.'), b_rdns = b.includes('.');
    if (a_rdns === b_rdns) return false;
    let [rdns, bare] = a_rdns ? [a, b] : [b, a];
    return rdns.slice(rdns.lastIndexOf('.') + 1) === bare;
}

// Case-insensitive match of a list entry against the WM class or app id (".desktop" ignored);
// "name_name" snap names collapse to "name" and a reverse-DNS name matches a bare name equal to its last segment.
export function is_self_managed(wm_class, app_id, list) {
    let names = [wm_class, app_id].filter(Boolean);
    return list.some(entry => names.some(name => same_app(entry, name)));
}
