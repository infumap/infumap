// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use bitflags::bitflags;


bitflags! {
  pub struct  NoteFlags: i64 {
    const None =           0x000;
    const Heading3 =       0x001;
    const ShowCopyIcon =   0x002;
    const Heading1 =       0x004;
    const Heading2 =       0x008;
    const Bullet1 =        0x010;
    const AlignCenter =    0x020;
    const AlignRight =     0x040;
    const AlignJustify =   0x080;
    const HideBorder =     0x100;
    const Code       =     0x200;
  }
}

bitflags! {
  pub struct TableFlags: i64 {
    const None =           0x000;
    const ShowColHeader =  0x001;
  }
}
