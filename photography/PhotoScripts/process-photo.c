#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "cJSON.h"

#define JSONFILENAME "../photolist.json"

#ifdef cJSON__h
  #define INCLUDED 1
#else
  #define INCLUDED 0
#endif

// Create a unique identifier for the images? by reading the latest one?
// Create function to read all images from the file and prompt for caption/alt?
// Create function to remove an image by the alt or by the caption? or by the identifier
// Create function to alter caption or alt given an identifier
// Create function to reorder based on identifier?
// - Identifiers in multiples of 10 and you can reassign, then refactor?


cJSON *get_json_object(char *filename);
void print_json(cJSON *json);
int add_photo(cJSON *json);
int remove_photo(cJSON *json);
int edit_photo(cJSON *json);
int list_photos(cJSON *json);

int get_filepath(char *buffer);
int get_altcaption(char *buffer);
int get_highest_identifier(cJSON *json);
cJSON *PhotoPointerByIdentifier(cJSON *json, int identifier);
int PhotoIndexByIdentifier(cJSON *json, int identifier);


int main(void) {
	// Check that the library was properly included
	if (INCLUDED) {
		printf("Library included.\n");
	} else {
		printf("Library not included.\n");
	}

	// Open file and check successful
	cJSON *json = get_json_object(JSONFILENAME);
	if (json == NULL) {
		return 1;
	} else {
		printf("JSON successfully parsed.\n");
	}

	cJSON *photos = cJSON_GetObjectItemCaseSensitive(json, "photos");
	if (photos == NULL) {
		perror("Unsuccessful assignment of 'photos'.\n");
		return 1;
	}

	// Loop indefinitely(maybe until quit selected), accepting single character inputs
	while (1) {
		char c = '\n';
		char discard;

		// Print Menu
		printf("Please choose an option:\n"
				"\t[ a ] - Add Photo\n"
				"\t[ r ] - Remove Photo\n"
				"\t[ e ] - Edit Photo\n"
				"\t[ l ] - List Photos\n"
				"\t[ s ] - Write and Quit\n"
				"\t[ q ] - Quit Without Saving\n"
				"   Input: ");

		// Wait for input, condition for no newline and only accept first character
		while (c == '\n') {
			c = getchar();
		}
		while ((discard = getchar()) != '\n' && discard != EOF) {}
		printf("Character entered: %c\n", c);

		print_json(json);

		// Switch on character
		switch (c) {
			case 'a':
				// Add photo
				add_photo(photos);
				break;
			case 'r':
				// Remove photo
				remove_photo(photos);
				break;
			case 'e':
				// Edit photo
				edit_photo(photos);
				break;
			case 'l':
				// Hopefully list photos
				list_photos(photos);
				break;
			case 's':
				// Write and quit
				printf("Saving and Quitting.\n");
				return 0;
				break;
			case 'q':
				// Quit without saving
				printf("Quitting without saving.\n");
				return 0;
				break;
			default:
				// Default option for other character
				printf("Please enter a valid option:\n");
				break;
		}
	}
	return 0;
}


// Print the json object
void print_json(cJSON *json) {
	char *string = cJSON_Print(json);
	printf("%s\n", string);
	free(string);
}


// Given filename, open if possible and return non-null json pointer
// This will require cleanup with free()
cJSON *get_json_object(char *filename) {

	// Open file 
	FILE* fp = fopen(filename, "r");
	if (fp == NULL) {
		perror("File failed to open.\n");
		return NULL;
	}

	// Read file
	char buffer[30000];
	fread(buffer, 1, 30000, fp);
	if (strlen(buffer) == 0) {
		perror("No characters read from file.\n");
		return NULL;
	} else {
		printf("Read %lu characters.\n", strlen(buffer));
	}

	// Parse JSON
	cJSON *json = cJSON_Parse(buffer);
	if (json == NULL) {
		perror("Failed to read JSON.\n");
		return NULL;
	}

	// Cleanup and return
	fclose(fp);
	return json;
}


// Add photo to json
int add_photo(cJSON *json) {

	// Create Photo object
	cJSON *photo = cJSON_CreateObject();

	// Get the highest identifier from existing photos
	int max = get_highest_identifier(json);

	// Get src, alt, and caption, add strings to object
	char inputBuffer[256];
	printf("The identifier will be: %d\n", (max + 1));
	get_filepath(inputBuffer);
	cJSON_AddStringToObject(photo, "src", inputBuffer);

	printf("Enter the 'alt': ");
	get_altcaption(inputBuffer);
	cJSON_AddStringToObject(photo, "alt", inputBuffer);

	printf("Enter the caption: ");
	get_altcaption(inputBuffer);
	cJSON_AddStringToObject(photo, "caption", inputBuffer);

	cJSON_AddNumberToObject(photo, "identifier", max + 1);

	// Add Photo Item to Photos Array
	cJSON_AddItemToArray(json, photo);

	return max + 1;
}


// Remove photo by identifier
int remove_photo(cJSON *json) {

	// Request identifier from user
	int identifierToRemove;
	printf("Enter the identifier of the photo to remove: ");
	scanf("%d", &identifierToRemove);
	printf("Removing item %d.\n", identifierToRemove);

	// Loop through photos looking for identifier, when found, remove
	cJSON *loop = json ? json->child : 0;
	int count = 0;
	while (loop) {

		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifierToRemove) {
			cJSON_DeleteItemFromArray(json, count);
			printf("Photo removed.\n");
			return count;
		}

		loop = loop->next;
		count += 1;
	}

	// If identifier not found, notify user
	printf("Could not find photo with identifier %d.\n", identifierToRemove);
	return -1;
}


// Edit photo by identifier
int edit_photo(cJSON *json) {
	printf("This function has not been implemented yet.\n");
	// ReplaceItemInArray or ReplaceItemViaPointer or ReplaceItemInObjectCaseSensitive

	// Request identifier from user
	int identifierToEdit;
	printf("Enter the identifier of the photo to edit: ");
	scanf("%d", &identifierToEdit);
	printf("Selecting item %d.\n", identifierToEdit);

	// Loop through photos looking for identifier, when found present present
	cJSON *loop = json ? json->child : 0;
	int count = 0;
	while (loop) {

		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifierToEdit) {




			return count;
		}

		loop = loop->next;
		count += 1;
	}
	return 1;
}


// List all photos by identifier, src, alt, and caption
int list_photos(cJSON *json) {

	// Read through all photos and print
	cJSON *loop = json ? json->child : 0;
	int count = 0;

	printf("Photos in 'photolist.json':\n");
	while (loop) {

		printf("Identifier:\t %d\n", cJSON_GetObjectItem(loop, "identifier")->valueint);
		printf("Caption:\t %s\n", cJSON_GetObjectItem(loop, "caption")->valuestring);
		printf("alt:\t\t %s\n", cJSON_GetObjectItem(loop, "alt")->valuestring);
		printf("src:\t\t %s\n\n", cJSON_GetObjectItem(loop, "src")->valuestring);

		loop = loop->next;
		count += 1;
	}

	return count;
}


/* Utility Functions */


// Given buffer, get input for photo filepath
int get_filepath(char *buffer) {

	char temp[100] = "/photography/photos/";
	// Request input from user with file prefix
	printf("Enter the filepath of the photo:\n/photography/photos/");
	scanf("%s", buffer);

	// Prepend the path and copy back to buffer
	strcat(temp, buffer);
	memcpy(buffer, temp, 100 * sizeof(char));

	return strlen(buffer);
}


// Given buffer, get alt or caption input
int get_altcaption(char *buffer) {
	// Request input to given buffer and return
	scanf("%s", buffer);
	return strlen(buffer);
}


// Return the highest identifier of the photos
int get_highest_identifier(cJSON *json) {
	int max = 1;
	cJSON *loop = json ? json->child : 0;

	while (loop) {
		cJSON *val = cJSON_GetObjectItem(loop, "identifier");
		if (val->valueint > max) {
			max = val->valueint;
		}
		loop = loop->next;
	}
	return max;
}


// Given json array and photo identifier, return pointer to object in array, null if not found
cJSON *PhotoPointerByIdentifier(cJSON *json, int identifier) {

	cJSON *loop = json ? json->child : 0;

	while (loop) {
		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifier) {
			return loop;
		}
		loop = loop->next;
	}
	return NULL;
}


// Given json array and photo identifier, return index of object in array, -1 if not found
int PhotoIndexByIdentifier(cJSON *json, int identifier) {

	cJSON *loop = json ? json->child : 0;
	int count = 0;

	while (loop) {
		if (cJSON_GetObjectItem(loop, "identifier")->valueint == identifier) {
			return count;
		}
		loop = loop->next;
		count += 1;
	}
	return -1;
}