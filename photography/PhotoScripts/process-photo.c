#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "cJSON.h"

#ifdef cJSON__h
  #define INCLUDED 1
#else
  #define INCLUDED 0
#endif


void print_json(cJSON *json);
void add_photo(void);

int main(void) {
	if (INCLUDED) {
		printf("Library included.\n");
	} else {
		printf("Library not included.\n");
	}

	add_photo();


	return 0;
}


void print_json(cJSON *json) {
	char *string = cJSON_Print(json);
	printf("%s\n", string);
	free(string);
}


void add_photo(void) {

	// Read the json file
	char buffer[30000];
	FILE* fp = fopen("../photolist.json", "r");
	fread(buffer, 1, 30000, fp);
	printf("Read %lu characters.\n", strlen(buffer));

	// Parse json
	cJSON *json = cJSON_Parse(buffer);
	cJSON * photos = cJSON_GetObjectItemCaseSensitive(json, "photos");
	print_json(json);

	/* Introduce loop with input requests here */

	// Create Photo object
	cJSON *photo = cJSON_CreateObject();

	// Add string to object x3
	cJSON_AddStringToObject(photo, "src", "/photography/photos/9.jpeg");
	cJSON_AddStringToObject(photo, "caption", "test2");
	cJSON_AddStringToObject(photo, "alt", "test3");

	// Add Photo Item to Photos Array
	cJSON_AddItemToArray(photos, photo);



	printf("New JSON\n");
	print_json(json);


	// Create output and write to file
	char *output = cJSON_Print(json);
	FILE* fwrite = fopen("../photolist.json", "w+");
	fprintf(fwrite, "%s", output);

	// Cleanup
	free(output);
	cJSON_Delete(json);
	fclose(fp);
	fclose(fwrite);
}

// Make function to remove photo from the list.  Done by src, alt, or caption?
