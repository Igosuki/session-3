
/* lib/match.js
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

export function args_to_command(comm) {
    return comm.map(arg => /[\s"'\\]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg).join(' ');
}

// Convert command into a regex pattern and see if commstr matches it:
export function compare_command_commstr(command, commstr) {
    let pattern = '';
    const regex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"'\s]+/g; // argument
    let token;
    while ((token = regex.exec(command)) !== null) {
        // In .desktop file Exec: %f/%u = 1 argument; %F/%U = multiple arguments
        if (/^%[fu]$/i.test(token[0])) {
            pattern += '(?:\\s+(?:' + regex.source + '))';
            if (/^%[FU]$/.test(token[0])) pattern += '*';
            pattern += '?';
        } else {
            if (pattern) pattern += '\\s+';
            pattern += token[0].replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        }
    }
    pattern = '^'+pattern+'$';
    return new RegExp(pattern).test(commstr);
}

export function levenshtein(str1, str2) {
    if (str1 == null) str1 = '';
    if (str2 == null) str2 = '';
    let matrix = [];
    
    // Initialize first row and column
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    // Fill the matrix
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    
    let distance = matrix[str2.length][str1.length];        
    let maxLength = Math.max(str1.length, str2.length);
    return (maxLength - distance) / maxLength;
}

// This is a Hungarian maximum-weight bipartite matching algorithm:
// It goes through every possible restore<->current set (map)
// combination, to find which has the highest total score.
// group[restore id][current id] = score; returns [total score, map].
export function hungarian_match(group) {
    let rids = Object.keys(group);

    let cids = new Set();
    for (let rid of rids) for (let cid of Object.keys(group[rid])) cids.add(cid);
    cids = [...cids]; // Remove duplicates

    // No match case (fewer current windows than restore session):
    while (cids.length < rids.length) cids.push(`NULL#${cids.length}`);

    // Since the Hungarian algorithm minimizes, build the cost nxn
    // matrix using costs = negated scores:
    const n = Math.max(rids.length, cids.length);
    const cost = Array.from({ length: n }, (_, i) => {
        if (i >= rids.length) return new Array(n).fill(-1); // Unmatched current window
        return Array.from({ length: n }, (_, j) => {
            if (/^NULL#\d+$/.test(cids[j])) return -1; // Unmatched restore window
            return -group[rids[i]][cids[j]]; // cost[i][j] = cost of assigning rids[i] → cids[j]
        })
    });

    // Hungarian minimization algorithm:
    const INF = 1e9;
    let u = new Array(n + 1).fill(0); // potential for rows
    let v = new Array(n + 1).fill(0); // potential for columns
    let p = new Array(n + 1).fill(0); // assignment: p[j] = row assigned to col j (1-indexed)
    let way = new Array(n + 1).fill(0);

    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        let minDist = new Array(n + 1).fill(INF);
        let used    = new Array(n + 1).fill(false);

        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = INF;
            let j1 = -1;

            for (let j = 1; j <= n; j++) {
                if (!used[j]) {
                    let cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minDist[j]) {
                        minDist[j] = cur;
                        way[j] = j0;
                    }
                    if (minDist[j] < delta) {
                        delta = minDist[j];
                        j1 = j;
                    }
                }
            }

            for (let j = 0; j <= n; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j]    -= delta;
                } else {
                    minDist[j] -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);

        do {
            p[j0] = p[way[j0]];
            j0    = way[j0];
        } while (j0);
    }

    let score = 0;
    let map = {};
    for (let j = 1; j <= n; j++) {
        if (p[j] !== 0 && p[j] - 1 < rids.length) {
            map[rids[p[j] - 1]] = cids[j - 1];
            score += -cost[p[j] - 1][j - 1]; // Score is negated cost
        }
    }
    return [score, map];
}
