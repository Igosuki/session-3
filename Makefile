UUID    = session-3@igosuki.github.io
SCHEMA  = schemas/org.gnome.shell.extensions.session-3.gschema.xml
DEST    = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ROOT   := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: schemas test install uninstall zip nested

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA)
	glib-compile-schemas --strict schemas/

test:
	@for t in tests/*.test.js; do echo "== $$t"; gjs -m $$t || exit 1; done

install: schemas
	mkdir -p $(dir $(DEST))
	ln -sfn $(ROOT:/=) $(DEST)

uninstall:
	rm -f $(DEST)

zip: schemas
	gnome-extensions pack --force --extra-source=lib --schema=$(SCHEMA) --out-dir=. .

nested:
	dbus-run-session gnome-shell --devkit --wayland --virtual-monitor 1920x1080 --virtual-monitor 1280x1024
