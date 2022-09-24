
from datetime import date, time
import requests
import time

# Define the categories
CATEGORIES = {"􀙚": {1: "project1"},
              "􀆔": {2: "project2", 3: "project3", 4: "project4"},
              "􀑇": {5: "project5", 6: "project6", 7: "project7", 8: "project8"}}


def get_data():
    """ Retrieve the data from the APIs """
    # Set up request parameters
    toggl_url = "https://api.track.toggl.com/reports/api/v2/details"
    toggl_url_current = "https://api.track.toggl.com/api/v8/time_entries/current"
    uid = "uid" # confidential
    pw = "api_token"
    wid = "wid" # confidential
    dt = date.today().isoformat()
    # Combine parameters into args for url
    arg = {'workspace_id': wid, 'since': dt, 'user_agent': "SwiftBar Plugin"}

    # Issue GET for today's time entries
    resp = requests.get(toggl_url,
                        params=arg,
                        auth=(uid, pw)).json()

    # Issue GET to v8 API to get any current time entry
    current = requests.get(toggl_url_current,
                           auth=(uid, pw)).json()

    # If there is a current time entry then add it to the data dictionary
    if current["data"] is not None:
        resp["data"].append({"pid": current["data"]["pid"], "dur": (int(time.time()) + current["data"]["duration"])*1000})

    return resp


def projectize_data(data):
    """ Gather the data into the different projects """
    tsum = {}
    for i in data["data"]:
        tsum[i['pid']] = tsum.get(i['pid'], 0) + i['dur']
    return tsum


def categorize_data(data):
    """ Create dictionary containing the sum of the minutes for each category"""
    op = {}
    data = data.copy()

    for k, v in CATEGORIES.items():
        for v1, v2 in v.items():
            if v1 in data:
                op[k] = op.get(k, 0) + data[v1]
    return op


def main():

    # Try to retrieve the data and error out if it doesn't work
    # This is so non-critical that in the event of some sort of failure it is no problem if I am without data for a few minutes
    try:
        data = get_data()
    except:
        data = None
    finally:
        if (data is None) or (data["total_count"] == 0):
            print("􀟗")
            quit()

    # Process data according to projects and categories
    processed_data = categorize_data(projectize_data(data))

    # Print the string
    prString = ""
    for k, v in processed_data.items():
        prString += f"{k[0]}:{round(v/60000)} "
    print(prString[:-1])


if __name__ == "__main__":
    main()
