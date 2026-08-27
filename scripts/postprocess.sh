#!/bin/bash

# This file executes the post-processing steps for a task after a dataset 
# has been processed by OpenDroneMap. It generates secondary outputs.
# 
# As a general rule, post-processing commands should never fail the task 
#(for example, if a point cloud could not be generated, the PotreeConverter 
# step will fail, but the script should still continue processing the rest and
# return a 0 code). The idea is to post-process as much as possible, knowing 
# that some parts might fail and that partial results should be returned in such cases.

if [ -z "$1" ]; then
	echo "Usage: $0 <projectPath>"
	exit 0
fi

# Switch to project path folder (data/<uuid>/)
script_path=$(realpath $(dirname "$0"))
cd "$script_path/../$1"
echo "Postprocessing: $(pwd)"

run_entwine_with_backoff() {
    local input_path="$1"
    local output_path="entwine_pointcloud"
    local tmp_path="entwine_pointcloud-tmp"
    local available_threads
    local max_threads
    local thread_candidates
    local tried_threads=" "
    local thread_count
    local exit_code

    available_threads=$(nproc 2>/dev/null || echo 1)
    max_threads=${ODM_ENTWINE_MAX_THREADS:-16}

    if ! [[ "$max_threads" =~ ^[0-9]+$ ]] || [ "$max_threads" -lt 1 ]; then
        max_threads=16
    fi

    if [ "$available_threads" -lt "$max_threads" ]; then
        max_threads="$available_threads"
    fi

    thread_candidates="$max_threads 16 8 4 2 1"

    for thread_count in $thread_candidates; do
        if [ "$thread_count" -gt "$max_threads" ]; then
            continue
        fi

        case "$tried_threads" in
            *" $thread_count "*) continue ;;
        esac
        tried_threads="$tried_threads$thread_count "

        echo "Running Entwine with $thread_count thread(s)..."
        rm -fr "$output_path" "$tmp_path"

        entwine build --threads "$thread_count" --tmp "$tmp_path" -i "$input_path" -o "$output_path"
        exit_code=$?

        if [ "$exit_code" -eq 0 ] && [ -f "$output_path/ept.json" ]; then
            echo "Entwine generated $output_path/ept.json with $thread_count thread(s)."
            rm -fr "$tmp_path"
            return 0
        fi

        echo "Entwine failed or produced incomplete output with $thread_count thread(s) (exit code $exit_code)."
        rm -fr "$output_path" "$tmp_path"
    done

    echo "Entwine failed for all attempted thread counts; falling back to PotreeConverter if available."
    return 1
}

# Generate point cloud (if entwine, untwine or potreeconverter is available)
pointcloud_input_path=""
for path in "odm_georeferencing/odm_georeferenced_model.laz" \
            "odm_georeferencing/odm_georeferenced_model.las" \
            "odm_filterpoints/point_cloud.ply" \
            "opensfm/depthmaps/merged.ply" \
            "smvs/smvs_dense_point_cloud.ply" \
            "mve/mve_dense_point_cloud.ply" \
            "pmvs/recon0/models/option-0000.ply"; do
    if [ -e $path ]; then
        echo "Found point cloud: $path"
        pointcloud_input_path=$path
        break
    fi
done

if [ ! -z "$pointcloud_input_path" ]; then
    # Convert the failsafe PLY point cloud to laz in odm_georeferencing 
    # if necessary, otherwise it will not get zipped
    if [ "$pointcloud_input_path" == "odm_filterpoints/point_cloud.ply" ] || [ "$pointcloud_input_path" == "opensfm/depthmaps/merged.ply" ] || [ "$pointcloud_input_path" == "pmvs/recon0/models/option-0000.ply" ]; then
        echo "Converting $pointcloud_input_path to odm_georeferencing/odm_georeferenced_model.laz, even though it's not georeferenced..."
        if hash pdal 2>/dev/null; then
            pdal translate -i "$pointcloud_input_path" -o "odm_georeferencing/odm_georeferenced_model.laz"
            if [ -e "odm_georeferencing/odm_georeferenced_model.laz" ]; then
                pointcloud_input_path="odm_georeferencing/odm_georeferenced_model.laz"
            fi
        else
            echo "Cannot find pdal, skipping conversion"
        fi
    fi
    

    if [ -f "entwine_pointcloud" ]; then
        echo "Found entwine_pointcloud as a file, removing (invalid EPT output)."
        rm -f "entwine_pointcloud"
    fi

    if [ "${ODM_DISABLE_ENTWINE:-0}" != "0" ]; then
        echo "Skipping Entwine (ODM_DISABLE_ENTWINE=${ODM_DISABLE_ENTWINE:-0})"
    else
        if hash entwine 2>/dev/null; then
            if [ ! -d "entwine_pointcloud" ]; then
                run_entwine_with_backoff "$pointcloud_input_path"
            else
                echo "Entwine point cloud is already built."
            fi
            
            # Cleanup
            if [ -e "entwine_pointcloud-tmp" ]; then
                rm -fr "entwine_pointcloud-tmp"
            fi
        fi
    fi

    # Skip untwine: in this environment it can generate a single LAZ file
    # named "entwine_pointcloud", which breaks WebODM's EPT lookup.

    if [ ! -f "entwine_pointcloud/ept.json" ] || [ "${ODM_DISABLE_ENTWINE:-0}" != "0" ]; then
        echo "Checking if PotreeConverter is available..."
        if hash PotreeConverter 2>/dev/null; then
            if [ ! -e "PotreeConverter" ] && [ -d "/code/PotreeConverter" ]; then
                ln -s /code/PotreeConverter PotreeConverter
            fi
            PotreeConverter "$pointcloud_input_path" -o potree_pointcloud --overwrite -a RGB CLASSIFICATION
        else
            echo "PotreeConverter is not installed, will skip generation of Potree point cloud"
        fi
    fi
else
    echo "Point cloud tiles will not be generated"
fi


echo "Postprocessing: done (•̀ᴗ•́)و!"
exit 0
