#!/usr/bin/env python
'''
NodeODM App and REST API to access ODM. 
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
'''

import sys
import argparse
import json
import os
import importlib.util


def _load_module_from_path(name, path):
    """Load a module from a given file path using importlib (replaces deprecated imp)."""
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dest_file = os.environ.get("ODM_OPTIONS_TMP_FILE")

sys.path.append(sys.argv[2])

_load_module_from_path('opendm', os.path.join(sys.argv[2], 'opendm', '__init__.py'))
_load_module_from_path('context', os.path.join(sys.argv[2], 'opendm', 'context.py'))
odm = _load_module_from_path('config', os.path.join(sys.argv[2], 'opendm', 'config.py'))
if odm is None:
    raise ImportError("Unable to load opendm/config.py")

options = {}
class ArgumentParserStub(argparse.ArgumentParser):
    def add_argument(self, *args, **kwargs):
        argparse.ArgumentParser.add_argument(self, *args, **kwargs)
        options[args[0]] = {}
        for name, value in kwargs.items():
            options[args[0]][str(name)] = str(value)
    
    def add_mutually_exclusive_group(self):
        return ArgumentParserStub()


if not hasattr(odm, 'parser'):
    # ODM >= 2.0
    odm.config(parser=ArgumentParserStub())
else:
    # ODM 1.0
    odm.parser = ArgumentParserStub()
    odm.config()
    
out = json.dumps(options)
print(out)
if dest_file is not None:
    with open(dest_file, "w") as f:
        f.write(out)
