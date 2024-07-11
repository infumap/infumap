#!/bin/bash

# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.


if [[ $# -eq 0 ]] ; then
    echo 'A tool for sorting images exported from Apple Photos into a more convenient folder structure for uploading to Infumap.'
    echo 'In the case of HEIC files, they will be placed in _photos_original and the corresponding scaled version in _photos.'
    echo 'All other files (which typically come from sources other than the camera) the unmodified version will be placed in _other (with no corresponding file in _photos).'
    echo ''
    echo 'Usage: .. <exported apple photos folder>'
    echo '  <exported apple photos folder> must have two subdirs with image files:'
    echo '   1. originals'
    echo '   2. processed'
    echo 'Suitable parameters for the "processed" export: JPEG, Medium, Original, Large, Use File Name.'
    echo 'The "originals" export should be via "Export Unmodified Originals".'
    echo ''
    exit 0
fi

if [ ! -d $1/originals ]; then
    echo 'originals subdir does not exist'
    exit 0
fi

if [ ! -d $1/processed ]; then
    echo 'processed subdir does not exist'
    exit 0
fi

if [ -d $1/_photos ]; then
    echo 'photos subdir already exist'
    exit 0
fi

if [ -d $1/_photos_original ]; then
    echo 'photos_original subdir already exist'
    exit 0
fi

if [ -d $1/_other ]; then
    echo 'other subdir already exist'
    exit 0
fi

mkdir $1/_photos
mkdir $1/_photos_original
mkdir $1/_other

for originals_path in $1/originals/*.HEIC; do
    heic_filename=$(basename $originals_path)
    processed_path=$1/processed/${heic_filename%.HEIC}.jpeg
    cp $originals_path $1/_photos_original
    cp $processed_path $1/_photos
done

for originals_file in $(ls $1/originals | grep -v HEIC$); do
    originals_path=$1/originals/$originals_file
    cp $originals_path $1/_other
done
