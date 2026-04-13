package com.swp391.datalabeling.dto.request;

import jakarta.validation.constraints.NotNull;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class TaskAssignRequest {

    @NotNull(message = "Data item ID is required")
    private Long dataItemId;

    @NotNull(message = "Annotator ID is required")
    private Long annotatorId;
}
